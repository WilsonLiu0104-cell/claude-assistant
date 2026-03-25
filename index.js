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

// 专门用来解析自然语言时间的 prompt
async function parseReminderIntent(text, nowIso) {
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    system: `你是一个时间解析助手。当前时间（Asia/Shanghai）：${nowIso}
用户输入一句话，你判断是否包含"提醒"意图。
如果是，返回 JSON（只返回 JSON，不加任何说明）：
{
  "isReminder": true,
  "reminderText": "提醒内容（简短）",
  "fireAtISO": "触发时间的 ISO8601 字符串，Asia/Shanghai 时区",
  "repeatCron": "如果是每日/每周重复，填 cron 表达式（Asia/Shanghai），否则填 null"
}
如果不是提醒意图，返回：{"isReminder": false}

示例：
- "下午3点提醒我开会" → fireAtISO 为今天15:00，repeatCron: null
- "每天早上9点提醒我喝水" → fireAtISO 为明天09:00，repeatCron: "0 9 * * *"
- "30分钟后提醒我回邮件" → fireAtISO 为30分钟后，repeatCron: null
- "明天上午10点提醒我打电话给王总" → 明天10:00，repeatCron: null`,
    messages: [{ role: 'user', content: text }],
  });
  try {
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return { isReminder: false };
  }
}

// 普通对话
async function askClaude(cid, userMessage) {
  saveMessage(cid, 'user', userMessage);
  const history = getHistory(cid, 20);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `你是一个高效的个人助手，运行在 Slack 里。回答简洁，善用 Slack markdown（*粗体*、_斜体_、\`代码\`）。当前时间：${now}`,
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
  const delay = fire_at - Date.now();

  if (repeat_cron) {
    // 每日/每周循环
    cron.schedule(repeat_cron, () => fireReminder(channel_id, user_id, message), { timezone: 'Asia/Shanghai' });
    console.log(`🔁 循环提醒已恢复 [${id}]: ${repeat_cron} → ${message}`);
  } else if (delay > 0) {
    // 一次性
    setTimeout(() => {
      fireReminder(channel_id, user_id, message);
      db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`).run(id);
    }, delay);
    console.log(`⏰ 一次性提醒已恢复 [${id}]: ${new Date(fire_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} → ${message}`);
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
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  // 先用 Claude 判断是否是提醒意图
  const intent = await parseReminderIntent(text, now);

  if (intent.isReminder && intent.fireAtISO) {
    const fireAt = addReminder({
      channelId,
      userId,
      message: intent.reminderText,
      fireAtISO: intent.fireAtISO,
      repeatCron: intent.repeatCron,
    });

    const fireTime = new Date(fireAt).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const repeatHint = intent.repeatCron ? '（每日重复）' : '';
    await replyFn(`✅ 提醒已设置${repeatHint}\n*时间：* ${fireTime}\n*内容：* ${intent.reminderText}`);
    return;
  }

  // 普通对话
  const reply = await askClaude(`dm_${userId}`, text);
  await replyFn(reply);
}

// ─── 事件监听 ─────────────────────────────────────────────

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

// /claude 斜杠命令
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
