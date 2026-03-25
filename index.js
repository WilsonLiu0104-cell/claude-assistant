require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const Database = require('better-sqlite3');

// ─── 数据库初始化 ────────────────────────────────────────
const db = new Database('conversations.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_conv ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    message     TEXT NOT NULL,
    hour        INTEGER NOT NULL,
    minute      INTEGER NOT NULL,
    active      INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 读取最近 N 条消息（按时间正序）
function getHistory(conversationId, limit = 20) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(conversationId, limit).reverse();
}

// 写入一条消息
function saveMessage(conversationId, role, content) {
  db.prepare(`
    INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)
  `).run(conversationId, role, content);
}

// 清空会话历史（/claude reset）
function clearHistory(conversationId) {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
}

// ─── Claude 调用 ─────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `你是一个高效的个人助手，运行在 Slack 里。职责：
1. 回答问题、帮助思考、处理各类任务
2. 帮用户设置提醒：用户说"提醒 HH:MM 内容"，你解析后设定每日定时提醒
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

// ─── 提醒系统 ─────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

function parseReminder(text) {
  const m = text.match(/提醒\s+(\d{1,2}):(\d{2})\s+(.+)/);
  return m ? { hour: parseInt(m[1]), minute: parseInt(m[2]), message: m[3] } : null;
}

function scheduleReminder({ channel_id, user_id, hour, minute, message }) {
  const cronExp = `${minute} ${hour} * * *`;
  cron.schedule(cronExp, async () => {
    await app.client.chat.postMessage({
      channel: channel_id,
      text: `⏰ <@${user_id}> 提醒：*${message}*`,
    });
  }, { timezone: 'Asia/Shanghai' });
}

// 启动时从数据库恢复所有活跃提醒
function restoreReminders() {
  const rows = db.prepare(`SELECT * FROM reminders WHERE active = 1`).all();
  rows.forEach(scheduleReminder);
  console.log(`✅ 已恢复 ${rows.length} 个定时提醒`);
}

function addReminder(channelId, userId, hour, minute, message) {
  db.prepare(`
    INSERT INTO reminders (channel_id, user_id, message, hour, minute)
    VALUES (?, ?, ?, ?, ?)
  `).run(channelId, userId, message, hour, minute);

  scheduleReminder({ channel_id: channelId, user_id: userId, hour, minute, message });
}

// ─── 事件监听 ─────────────────────────────────────────────

// 频道 @mention
app.event('app_mention', async ({ event, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const convId = event.channel;

  try {
    const reminder = parseReminder(text);
    if (reminder) {
      addReminder(event.channel, event.user, reminder.hour, reminder.minute, reminder.message);
      const t = `${String(reminder.hour).padStart(2, '0')}:${String(reminder.minute).padStart(2, '0')}`;
      await say({ text: `✅ 每日提醒已设置 *${t}* — ${reminder.message}（重启后依然有效）`, thread_ts: event.ts });
      return;
    }
    const reply = await askClaude(convId, text);
    await say({ text: reply, thread_ts: event.ts });
  } catch (e) {
    console.error(e);
    await say({ text: '出了点问题 😅 请稍后再试', thread_ts: event.ts });
  }
});

// 私信（DM）
app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im' || message.bot_id) return;
  const text = message.text || '';
  const convId = `dm_${message.user}`;

  try {
    const reminder = parseReminder(text);
    if (reminder) {
      addReminder(message.channel, message.user, reminder.hour, reminder.minute, reminder.message);
      const t = `${String(reminder.hour).padStart(2, '0')}:${String(reminder.minute).padStart(2, '0')}`;
      await say(`✅ 每日提醒已设置：*${t}* — ${reminder.message}`);
      return;
    }
    const reply = await askClaude(convId, text);
    await say(reply);
  } catch (e) {
    console.error(e);
    await say('出了点问题 😅');
  }
});

// 斜杠命令 /claude [内容] 或 /claude reset
app.command('/claude', async ({ command, ack, say }) => {
  await ack();
  const text = command.text.trim();
  const convId = `slash_${command.user_id}`;

  if (text === 'reset') {
    clearHistory(convId);
    await say({ text: '🗑️ 对话历史已清空', response_type: 'ephemeral' });
    return;
  }

  try {
    const reply = await askClaude(convId, text);
    await say({ text: reply, response_type: 'in_channel' });
  } catch (e) {
    await say({ text: '出错了，请稍后重试', response_type: 'ephemeral' });
  }
});

// ─── 启动 ─────────────────────────────────────────────────
(async () => {
  restoreReminders();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Claude Slack Bot 已启动（持久化模式）');
})();
