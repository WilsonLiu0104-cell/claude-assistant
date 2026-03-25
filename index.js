require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const Database = require('better-sqlite3');

// ─── 数据库初始化 ────────────────────────────────────────
const db = new Database('conversations.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_conv ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    message     TEXT NOT NULL,
    hour        INTEGER NOT NULL DEFAULT 0,
    minute      INTEGER NOT NULL DEFAULT 0,
    repeat      TEXT NOT NULL DEFAULT 'daily',
    fire_at     INTEGER,
    active      INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 兼容旧表
try { db.exec(`ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT 'daily'`); } catch {}
try { db.exec(`ALTER TABLE reminders ADD COLUMN fire_at INTEGER`); } catch {}

function getHistory(conversationId, limit = 20) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(conversationId, limit).reverse();
}

function saveMessage(conversationId, role, content) {
  db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`).run(conversationId, role, content);
}

function clearHistory(conversationId) {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
}

// ─── Claude 调用 ─────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `你是一个高效的个人助手，运行在 Slack 里。职责：
1. 回答问题、帮助思考、处理各类任务
2. 支持设置提醒，格式：
   - 每日定时："提醒 HH:MM 内容"（例：提醒 09:00 检查邮件）
   - 相对时间："X分钟后提醒 内容" 或 "X小时后提醒 内容"（例：30分钟后提醒 喝水）
3. 回答简洁，善用 Slack markdown（*粗体*、_斜体_、\`代码\`、> 引用）
当前时间：`;

async function askClaude(conversationId, userMessage) {
  saveMessage(conversationId, 'user', userMessage);
  const history = getHistory(conversationId, 20);

  const response = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    messages: history,
  });

  const reply = response.content[0].text;
  saveMessage(conversationId, 'assistant', reply);
  return reply;
}

// ─── Slack App ───────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 提醒解析 ─────────────────────────────────────────────

// 每日定时："提醒 09:00 内容"
function parseDailyReminder(text) {
  const m = text.match(/提醒\s+(\d{1,2}):(\d{2})\s+(.+)/);
  return m ? { type: 'daily', hour: parseInt(m[1]), minute: parseInt(m[2]), message: m[3] } : null;
}

// 相对时间："X分钟后提醒 内容" 或 "X小时后提醒 内容"
function parseRelativeReminder(text) {
  const mMin = text.match(/(\d+)\s*分钟后提醒\s*(.+)/);
  if (mMin) return { type: 'once', fireAt: Date.now() + parseInt(mMin[1]) * 60000, message: mMin[2] };
  const mHour = text.match(/(\d+)\s*小时后提醒\s*(.+)/);
  if (mHour) return { type: 'once', fireAt: Date.now() + parseInt(mHour[1]) * 3600000, message: mHour[2] };
  return null;
}

// ─── 调度 ─────────────────────────────────────────────────

function scheduleDaily({ channel_id, user_id, hour, minute, message }) {
  cron.schedule(`${minute} ${hour} * * *`, async () => {
    await app.client.chat.postMessage({
      channel: channel_id,
      text: `⏰ <@${user_id}> 提醒：*${message}*`,
    });
  }, { timezone: 'Asia/Shanghai' });
}

function scheduleOnce({ channel_id, user_id, fireAt, message }) {
  const delay = fireAt - Date.now();
  if (delay <= 0) return;
  setTimeout(async () => {
    await app.client.chat.postMessage({
      channel: channel_id,
      text: `⏰ <@${user_id}> 提醒：*${message}*`,
    });
    db.prepare(`UPDATE reminders SET active = 0 WHERE channel_id = ? AND message = ? AND fire_at = ?`)
      .run(channel_id, message, fireAt);
  }, delay);
}

function addReminder(channelId, userId, parsed) {
  if (parsed.type === 'daily') {
    db.prepare(`INSERT INTO reminders (channel_id, user_id, message, hour, minute, repeat) VALUES (?, ?, ?, ?, ?, 'daily')`)
      .run(channelId, userId, parsed.message, parsed.hour, parsed.minute);
    scheduleDaily({ channel_id: channelId, user_id: userId, ...parsed });
  } else {
    db.prepare(`INSERT INTO reminders (channel_id, user_id, message, repeat, fire_at) VALUES (?, ?, ?, 'once', ?)`)
      .run(channelId, userId, parsed.message, parsed.fireAt);
    scheduleOnce({ channel_id: channelId, user_id: userId, ...parsed });
  }
}

function restoreReminders() {
  const rows = db.prepare(`SELECT * FROM reminders WHERE active = 1`).all();
  rows.forEach(r => {
    if (r.repeat === 'daily') {
      scheduleDaily({ channel_id: r.channel_id, user_id: r.user_id, hour: r.hour, minute: r.minute, message: r.message });
    } else if (r.repeat === 'once' && r.fire_at > Date.now()) {
      scheduleOnce({ channel_id: r.channel_id, user_id: r.user_id, fireAt: r.fire_at, message: r.message });
    }
  });
  console.log(`✅ 已恢复 ${rows.length} 个定时提醒`);
}

// ─── 每日主动推送 ─────────────────────────────────────────
// 在 Railway Variables 里设置 OWNER_USER_ID = 你的 Slack 用户 ID（U开头）
function setupDailyProactive() {
  const userId = process.env.OWNER_USER_ID;
  if (!userId) {
    console.log('⚠️  未设置 OWNER_USER_ID，跳过每日主动推送');
    return;
  }

  // 每天早上 9:00 早安 + 今日行动建议
  cron.schedule('0 9 * * *', async () => {
    try {
      const today = new Date().toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai', weekday: 'long', month: 'long', day: 'numeric'
      });
      const res = await claude.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: `今天是${today}，给我一条简短的早安问候和3条今日行动建议，用 Slack markdown 格式，100字以内。` }],
      });
      await app.client.chat.postMessage({
        channel: userId,
        text: `☀️ *早安！*\n\n${res.content[0].text}`,
      });
    } catch (e) { console.error('早安推送失败', e); }
  }, { timezone: 'Asia/Shanghai' });

  // 每天晚上 21:00 晚间复盘
  cron.schedule('0 21 * * *', async () => {
    try {
      await app.client.chat.postMessage({
        channel: userId,
        text: `🌙 *晚间复盘*\n\n今天完成了哪些事情？有什么想记录或明天要跟进的？\n直接回复我，我帮你整理。`,
      });
    } catch (e) { console.error('晚间推送失败', e); }
  }, { timezone: 'Asia/Shanghai' });

  console.log(`✅ 每日主动推送已启动 → ${userId}（09:00 早安 / 21:00 复盘）`);
}

// ─── 消息处理（统一逻辑）────────────────────────────────────
async function handleMessage(text, channelId, userId, replyFn) {
  const daily = parseDailyReminder(text);
  if (daily) {
    addReminder(channelId, userId, daily);
    const t = `${String(daily.hour).padStart(2, '0')}:${String(daily.minute).padStart(2, '0')}`;
    await replyFn(`✅ 每日提醒已设置：*${t}* — ${daily.message}`);
    return;
  }

  const relative = parseRelativeReminder(text);
  if (relative) {
    addReminder(channelId, userId, relative);
    const fireTime = new Date(relative.fireAt).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit'
    });
    await replyFn(`✅ 提醒已设置：将在 *${fireTime}* 提醒你 — ${relative.message}`);
    return;
  }

  const reply = await askClaude(`dm_${userId}`, text);
  await replyFn(reply);
}

// 频道 @mention
app.event('app_mention', async ({ event, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  try {
    await handleMessage(text, event.channel, event.user, (msg) => say({ text: msg, thread_ts: event.ts }));
  } catch (e) {
    console.error(e);
    await say({ text: '出了点问题 😅 请稍后再试', thread_ts: event.ts });
  }
});

// 私信（DM）
app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im' || message.bot_id) return;
  try {
    await handleMessage(message.text || '', message.channel, message.user, (msg) => say(msg));
  } catch (e) {
    console.error(e);
    await say('出了点问题 😅');
  }
});

// 斜杠命令 /claude 或 /claude reset
app.command('/claude', async ({ command, ack, say }) => {
  await ack();
  const text = command.text.trim();
  if (text === 'reset') {
    clearHistory(`dm_${command.user_id}`);
    await say({ text: '🗑️ 对话历史已清空', response_type: 'ephemeral' });
    return;
  }
  try {
    await handleMessage(text, command.channel_id, command.user_id, (msg) => say({ text: msg, response_type: 'in_channel' }));
  } catch (e) {
    await say({ text: '出错了，请稍后重试', response_type: 'ephemeral' });
  }
});

// ─── 启动 ─────────────────────────────────────────────────
(async () => {
  restoreReminders();
  setupDailyProactive();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Claude Slack Bot 已启动（持久化 + 主动推送模式）');
})();
