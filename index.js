require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const Database = require('better-sqlite3');

const TZ = 'America/New_York';

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

  CREATE TABLE IF NOT EXISTS user_profile (
    user_id     TEXT PRIMARY KEY,
    profile     TEXT NOT NULL DEFAULT '{}',
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── 工具函数 ─────────────────────────────────────────────
function nowET() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }) + ' ET';
}

function getHistory(cid, limit = 20) {
  return db.prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`).all(cid, limit).reverse();
}
function saveMessage(cid, role, content) {
  db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`).run(cid, role, content);
}
function clearHistory(cid) {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(cid);
}
function getMessageCount(cid) {
  return db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?`).get(cid).cnt;
}
function getProfile(userId) {
  const row = db.prepare(`SELECT profile FROM user_profile WHERE user_id = ?`).get(userId);
  if (!row) return {};
  try { return JSON.parse(row.profile); } catch { return {}; }
}
function saveProfile(userId, profile, trigger = 'auto') {
  db.prepare(`
    INSERT INTO user_profile (user_id, profile, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = CURRENT_TIMESTAMP
  `).run(userId, JSON.stringify(profile));
  console.log(`🧠 画像已更新 [${userId}] trigger=${trigger}`);
}
function profileToHint(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = [];
  if (profile.language) lines.push(`回复语言：${profile.language}`);
  if (profile.tone) lines.push(`回复风格：${profile.tone}`);
  if (profile.reminderStyle) lines.push(`提醒风格：${profile.reminderStyle}`);
  if (profile.interests?.length) lines.push(`用户兴趣/工作重心：${profile.interests.join('、')}`);
  if (profile.customRules?.length) lines.push('特别指令：\n' + profile.customRules.map(r => `  - ${r}`).join('\n'));
  return lines.length > 0 ? `\n\n【用户偏好，请严格遵守】\n${lines.join('\n')}` : '';
}

// ─── Claude ──────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 意图解析（完全独立，不带对话历史）
async function parseIntent(text, now) {
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 400,
    system: `你是意图解析助手。当前时间（美东时间 ET）：${now}
用户所在时区：America/New_York（美东）。
分析用户输入，返回 JSON（只返回 JSON，不加说明或代码块）。

可能的意图和格式：

1. 设置提醒（含时间+提醒内容）：
{"intent":"reminder","reminderText":"内容","fireAtISO":"ISO8601美东时间","repeatCron":"cron或null"}

2. 偏好反馈（用户要求调整助手行为）：
{"intent":"preference","updatedProfile":{"language":"...","tone":"...","customRules":[...]}}

3. 普通对话：
{"intent":"chat"}

例子：
- "每天早上9点提醒我喝水" → reminder, repeatCron:"0 9 * * *"
- "30分钟后提醒我回邮件" → reminder, fireAtISO=now+30min, repeatCron:null
- "明天下午3点提醒我开会" → reminder, 明天15:00 ET
- "每天晚上11点提醒我睡觉" → reminder, repeatCron:"0 23 * * *"
- "以后回复我简洁一点" → preference
- "今天天气怎么样" → chat`,
    messages: [{ role: 'user', content: text }],
  });
  try {
    return JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  } catch { return { intent: 'chat' }; }
}

// 普通对话
async function askClaude(cid, userId, userMessage) {
  saveMessage(cid, 'user', userMessage);
  const history = getHistory(cid, 20);
  const profile = getProfile(userId);
  const profileHint = profileToHint(profile);

  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `你是一个高效的个人助手，运行在 Slack 里。已集成提醒系统，用户说含时间的提醒句子会被自动设为定时任务并准时推送。回答简洁，善用 Slack markdown（*粗体*、_斜体_、\`代码\`）。当前时间：${nowET()}${profileHint}`,
    messages: history,
  });

  const reply = res.content[0].text;
  saveMessage(cid, 'assistant', reply);
  autoEvolveProfile(userId, cid).catch(console.error);
  return reply;
}

// 后台自动进化（每10条触发）
async function autoEvolveProfile(userId, cid) {
  const count = getMessageCount(cid);
  if (count % 10 !== 0) return;
  const history = getHistory(cid, 30);
  const currentProfile = getProfile(userId);
  try {
    const res = await claude.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 400,
      system: `分析对话记录，提炼用户偏好，返回更新后的画像 JSON（只返回 JSON）。
格式：{"language":"...","tone":"...","reminderStyle":"...","interests":[...],"customRules":[...]}
当前画像：${JSON.stringify(currentProfile)}`,
      messages: [...history, { role: 'user', content: '请分析以上对话，更新用户画像。' }],
    });
    const updated = JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
    saveProfile(userId, updated, `auto_${count}`);
  } catch (e) { console.error('自动进化失败', e); }
}

// ─── Slack App ───────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ─── 提醒系统 ─────────────────────────────────────────────
function fireReminder(channelId, userId, message) {
  app.client.chat.postMessage({
    channel: channelId,
    text: `⏰ <@${userId}> 提醒：*${message}*`,
  }).catch(console.error);
}

function scheduleReminder(row) {
  const { id, channel_id, user_id, message, fire_at, repeat_cron } = row;
  if (repeat_cron) {
    cron.schedule(repeat_cron, () => fireReminder(channel_id, user_id, message), { timezone: TZ });
    console.log(`🔁 循环提醒 [${id}]: ${repeat_cron} → ${message}`);
  } else {
    const delay = fire_at - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        fireReminder(channel_id, user_id, message);
        db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`).run(id);
      }, delay);
      const t = new Date(fire_at).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      console.log(`⏰ 一次性提醒 [${id}]: ${t} ET → ${message}`);
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
  const now = nowET();

  let intent;
  try { intent = await parseIntent(text, now); }
  catch (e) { intent = { intent: 'chat' }; }

  // 设置提醒
  if (intent.intent === 'reminder' && intent.fireAtISO) {
    const fireAt = addReminder({
      channelId, userId,
      message: intent.reminderText,
      fireAtISO: intent.fireAtISO,
      repeatCron: intent.repeatCron,
    });
    const fireTime = new Date(fireAt).toLocaleString('zh-CN', {
      timeZone: TZ, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const repeatHint = intent.repeatCron ? '（每日重复 🔁）' : '（一次性）';
    await replyFn(`✅ 提醒已设置 ${repeatHint}\n*时间：* ${fireTime} ET\n*内容：* ${intent.reminderText}`);
    return;
  }

  // 偏好反馈
  if (intent.intent === 'preference' && intent.updatedProfile) {
    saveProfile(userId, intent.updatedProfile, 'user_feedback');
    const reply = await askClaude(`dm_${userId}`, userId, text);
    await replyFn(`${reply}\n\n_（已记住你的偏好 ✨）_`);
    return;
  }

  // 普通对话
  const reply = await askClaude(`dm_${userId}`, userId, text);
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
    await say({ text: '🗑️ 对话历史已清空（画像保留）', response_type: 'ephemeral' });
    return;
  }
  if (text === 'profile') {
    const profile = getProfile(command.user_id);
    const display = Object.keys(profile).length > 0
      ? '```\n' + JSON.stringify(profile, null, 2) + '\n```'
      : '还没有学到任何偏好，继续聊天会慢慢进化 🌱';
    await say({ text: `🧠 *当前用户画像：*\n${display}`, response_type: 'ephemeral' });
    return;
  }
  if (text === 'reset-profile') {
    db.prepare(`DELETE FROM user_profile WHERE user_id = ?`).run(command.user_id);
    await say({ text: '🗑️ 用户画像已清空，Bot 将重新学习你的偏好', response_type: 'ephemeral' });
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
  console.log('⚡️ Claude Slack Bot 已启动（提醒 + 自进化 | 时区：美东 ET）');
})();
