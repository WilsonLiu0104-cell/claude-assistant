require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const Database = require('better-sqlite3');

// ─── 数据库 ───────────────────────────────────────────────
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
    fire_at     INTEGER NOT NULL,
    repeat_cron TEXT,
    active      INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function getHistory(cid, limit = 20) {
  return db.prepare(
    `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(cid, limit).reverse();
}
function saveMessage(cid, role, content) {
  db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`).run(cid, role, content);
}
function clearHistory(cid) {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(cid);
}

// ─── Claude ──────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 第一步：专门判断是否有提醒意图，完全独立于对话历史
async function parseReminderIntent(text, nowStr) {
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    system: `你是时间解析助手。当前时间（Asia/Shanghai）：${nowStr}
判断用户输入是否包含"提醒"意图。只返回 JSON，不加任何说明。

有提醒意图时返回：
{
  "isReminder": true,
  "reminderText": "提醒内容（简短动词短语）",
  "fireAtISO": "触发时间 ISO8601，Asia/Shanghai 时区",
  "repeatCron": "循环时填 cron 表达式，否则填 null"
}

无提醒意图时返回：{"isReminder": false}

例子：
- "每天晚上11点提醒我洗澡" → isReminder:true, repeatCron:"0 23 * * *"
- "30分钟后提醒我喝水" → isReminder:true, repeatCron:null
- "明天下午3点提醒我开会" → isReminder:true, repeatCron:null
- "每周一早上提醒我写周报" → isReminder:true, repeatCron:"0 9 * * 1"
- "今天天气怎么样" → isReminder:false`,
    messages: [{ role: 'user', content: text }],
  });
  try {
    const raw = res.content[0].text.trim().replace(/```json|```/g, '');
    return JSON.parse(raw);
  } catch {
    return { isReminder: false };
  }
}

// 第二步：普通对话（已确认不是提醒意图才进入）
async function askClaude(cid, userMessage) {
  saveMessage(cid, 'user', userMessage);
  const history = getHistory(cid, 20);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `你是一个高效的个人助手，运行在 Slack 里。
能力说明：你已经集成了提醒系统，用户说任何包含时间+提醒的句子都会被自动处理为定时提醒并在指定时间主动推送消息。
回答简洁，善用 Slack markdown（*粗体*、_斜体_、\`代码\`）。
当前时间：${now}`,
    messages: history,
  });
  const reply = res.content[0].text;
  saveMessage(cid, 'assistant', reply);
  return reply;
}

// ─── Slack App ───────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 提醒调度 ─────────────────────────────────────────────
function fireReminder(channelId, userId, message) {
  app.client.chat.postMessage({
    channel: channelId,
    text: `⏰ <@${userId}> 提醒：*${message}*`,
  }).catch(console.error);
}

function scheduleReminder(row) {
  const { id, channel_id, user_id, message, fire_at, repeat_cron } = row;
  if (repeat_cron) {
    cron.schedule(repeat_cron, () => fireReminder(channel_id, user_id, message), { timezone: 'Asia/Shanghai' });
    console.log(`🔁 循环提醒 [${id}]: ${repeat_cron} → ${message}`);
  } else {
    const delay = fire_at - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        fireReminder(channel_id, user_id, message);
        db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`).run(id);
      }, delay);
      console.log(`⏰ 一次性提醒 [${id}]: ${new Date(fire_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} → ${message}`);
    }
  }
}

function addReminder({ channelId, userId, message, fireAtISO, repeatCron }) {
  const fireAt = new Date(fireAtISO).getTime();
  const result = db.prepare(
    `INSERT INTO reminders (channel_id, user_id, message, fire_at, repeat_cron) VALUES (?, ?, ?, ?, ?)`
  ).run(channelId, userId, message, fireAt, repeatCron || null);
  scheduleReminder({ id: result.lastInsertRowid, channel_id: channelId, user_id: userId, message, fire_at: fireAt, repeat_cron: repeatCron || null });
  return fireAt;
}

function restoreReminders() {
  const rows = db.prepare(`SELECT * FROM reminders WHERE active = 1`).all();
  rows.forEach(scheduleReminder);
  console.log(`✅ 已恢复 ${rows.length} 个提醒`);
}

// ─── 消息处理核心 ─────────────────────────────────────────
async function handleMessage(text, channelId, userId, replyFn) {
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  // 提醒意图检测优先，完全独立于对话历史
  let intent;
  try {
    intent = await parseReminderIntent(text, now);
  } catch (e) {
    console.error('提醒解析失败', e);
    intent = { isReminder: false };
  }

  if (intent.isReminder && intent.fireAtISO) {
    const fireAt = addReminder({
      channelId, userId,
      message: intent.reminderText,
      fireAtISO: intent.fireAtISO,
      repeatCron: intent.repeatCron,
    });
    const fireTime = new Date(fireAt).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const repeatHint = intent.repeatCron ? '（每日重复 🔁）' : '（一次性）';
    await replyFn(`✅ 提醒已设置 ${repeatHint}\n*时间：* ${fireTime}\n*内容：* ${intent.reminderText}`);
    return;
  }

  // 非提醒意图，走普通对话
  const reply = await askClaude(`dm_${userId}`, text);
  await replyFn(reply);
}

// ─── 事件监听 ─────────────────────────────────────────────

app.event('app_mention', async ({ event, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  try {
    await handleMessage(text, event.channel, event.user, (msg) => say({ text: msg, thread_ts: event.ts }));
  } catch (e) {
    console.error(e);
    await say({ text: '出了点问题 😅 请稍后再试', thread_ts: event.ts });
  }
});

app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im' || message.bot_id) return;
  try {
    await handleMessage(message.text || '', message.channel, message.user, (msg) => say(msg));
  } catch (e) {
    console.error(e);
    await say('出了点问题 😅');
  }
});

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
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Claude Slack Bot 已启动（自然语言提醒模式）');
})();
