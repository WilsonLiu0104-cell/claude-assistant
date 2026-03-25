require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { google } = require('googleapis');

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
  db.prepare(`INSERT INTO user_profile (user_id, profile, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = CURRENT_TIMESTAMP`).run(userId, JSON.stringify(profile));
  console.log(`🧠 画像已更新 [${userId}] trigger=${trigger}`);
}
function profileToSystemHint(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = [];
  if (profile.language) lines.push(`回复语言：${profile.language}`);
  if (profile.tone) lines.push(`回复风格：${profile.tone}`);
  if (profile.reminderStyle) lines.push(`提醒风格：${profile.reminderStyle}`);
  if (profile.interests?.length) lines.push(`用户兴趣/工作重心：${profile.interests.join('、')}`);
  if (profile.customRules?.length) lines.push('特别指令：\n' + profile.customRules.map(r => `  - ${r}`).join('\n'));
  return lines.length > 0 ? `\n\n【用户偏好】\n${lines.join('\n')}` : '';
}

// ─── Google Calendar ──────────────────────────────────────
function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const token = JSON.parse(process.env.GOOGLE_TOKEN);
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// 查询日程
async function listEvents(query) {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const tz = 'America/New_York';

    // 解析查询范围
    let timeMin = new Date(now);
    let timeMax = new Date(now);
    timeMin.setHours(0, 0, 0, 0);

    if (query.includes('本周') || query.includes('这周')) {
      const day = now.getDay() || 7;
      timeMin.setDate(now.getDate() - day + 1);
      timeMax.setDate(timeMin.getDate() + 6);
      timeMax.setHours(23, 59, 59, 999);
    } else if (query.includes('明天')) {
      timeMin.setDate(now.getDate() + 1);
      timeMax = new Date(timeMin);
      timeMax.setHours(23, 59, 59, 999);
    } else if (query.includes('后天')) {
      timeMin.setDate(now.getDate() + 2);
      timeMax = new Date(timeMin);
      timeMax.setHours(23, 59, 59, 999);
    } else {
      // 默认今天
      timeMax.setHours(23, 59, 59, 999);
    }

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: tz,
      maxResults: 20,
    });

    const events = res.data.items;
    if (!events || events.length === 0) return '（该时间段内没有日程）';

    return events.map(e => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleString('zh-CN', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : e.start.date;
      return `• ${start} ${e.summary}${e.location ? ' 📍' + e.location : ''}`;
    }).join('\n');
  } catch (e) {
    console.error('查询日历失败', e);
    return null;
  }
}

// 创建日程
async function createEvent({ summary, startISO, endISO, description, location }) {
  try {
    const calendar = getCalendarClient();
    const event = {
      summary,
      description,
      location,
      start: { dateTime: startISO, timeZone: 'America/New_York' },
      end: { dateTime: endISO, timeZone: 'America/New_York' },
    };
    const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
    return res.data;
  } catch (e) {
    console.error('创建日程失败', e);
    return null;
  }
}

// ─── Claude ──────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 意图解析：提醒 / 查日程 / 建日程 / 偏好反馈 / 普通对话
async function parseIntent(text, nowStr) {
  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 500,
    system: `你是意图解析助手。当前时间（美东时间 ET）：${nowStr}
分析用户输入，返回 JSON（只返回 JSON，不加说明或代码块）。

可能的意图类型和返回格式：

1. 设置提醒：
{"intent":"reminder","reminderText":"内容","fireAtISO":"ISO8601","repeatCron":"cron或null"}

2. 查询日程：
{"intent":"calendar_query","queryText":"原始查询"}

3. 创建日程：
{"intent":"calendar_create","summary":"标题","startISO":"ISO8601开始","endISO":"ISO8601结束（默认1小时后）","description":"备注或null","location":"地点或null"}

4. 偏好反馈：
{"intent":"preference","updatedProfile":{"language":"...","tone":"...","customRules":[...]}}

5. 普通对话：
{"intent":"chat"}

例子：
- "今天有什么会议" → calendar_query
- "帮我明天下午3点加个产品评审" → calendar_create
- "每天早上9点提醒我喝水" → reminder, repeatCron:"0 9 * * *"
- "以后回复简洁一点" → preference
- "今天天气怎么样" → chat`,
    messages: [{ role: 'user', content: text }],
  });
  try {
    return JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
  } catch { return { intent: 'chat' }; }
}

async function askClaude(cid, userId, userMessage, extraContext = '') {
  saveMessage(cid, 'user', userMessage);
  const history = getHistory(cid, 20);
  const profile = getProfile(userId);
  const profileHint = profileToSystemHint(profile);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'America/New_York' });

  const res = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `你是一个高效的个人助手，运行在 Slack 里。已集成提醒系统和 Google Calendar。回答简洁，善用 Slack markdown。当前时间：${now}${profileHint}${extraContext}`,
    messages: history,
  });
  const reply = res.content[0].text;
  saveMessage(cid, 'assistant', reply);
  autoEvolveProfile(userId, cid).catch(console.error);
  return reply;
}

async function autoEvolveProfile(userId, cid) {
  const count = getMessageCount(cid);
  if (count % 10 !== 0) return;
  const history = getHistory(cid, 30);
  const currentProfile = getProfile(userId);
  try {
    const res = await claude.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 400,
      system: `分析对话记录，提炼用户偏好，更新画像。只返回 JSON。
格式：{"language":"...","tone":"...","reminderStyle":"...","interests":[...],"customRules":[...]}
当前画像：${JSON.stringify(currentProfile)}`,
      messages: [
        ...history,
        { role: 'user', content: '请分析以上对话，更新用户画像。' }
      ],
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

// ─── 提醒调度 ─────────────────────────────────────────────
function fireReminder(channelId, userId, message) {
  app.client.chat.postMessage({ channel: channelId, text: `⏰ <@${userId}> 提醒：*${message}*` }).catch(console.error);
}
function scheduleReminder(row) {
  const { id, channel_id, user_id, message, fire_at, repeat_cron } = row;
  if (repeat_cron) {
    cron.schedule(repeat_cron, () => fireReminder(channel_id, user_id, message), { timezone: 'America/New_York' });
  } else {
    const delay = fire_at - Date.now();
    if (delay > 0) setTimeout(() => {
      fireReminder(channel_id, user_id, message);
      db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`).run(id);
    }, delay);
  }
}
function addReminder({ channelId, userId, message, fireAtISO, repeatCron }) {
  const fireAt = new Date(fireAtISO).getTime();
  const result = db.prepare(`INSERT INTO reminders (channel_id, user_id, message, fire_at, repeat_cron) VALUES (?, ?, ?, ?, ?)`).run(channelId, userId, message, fireAt, repeatCron || null);
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
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }) + ' 美东时间（ET）';

  let intent;
  try { intent = await parseIntent(text, now); }
  catch (e) { intent = { intent: 'chat' }; }

  // 设置提醒
  if (intent.intent === 'reminder' && intent.fireAtISO) {
    const fireAt = addReminder({ channelId, userId, message: intent.reminderText, fireAtISO: intent.fireAtISO, repeatCron: intent.repeatCron });
    const fireTime = new Date(fireAt).toLocaleString('zh-CN', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const repeatHint = intent.repeatCron ? '（每日重复 🔁）' : '（一次性）';
    await replyFn(`✅ 提醒已设置 ${repeatHint}\n*时间：* ${fireTime}\n*内容：* ${intent.reminderText}`);
    return;
  }

  // 查询日程
  if (intent.intent === 'calendar_query') {
    const hasCalendar = process.env.GOOGLE_CREDENTIALS && process.env.GOOGLE_TOKEN;
    if (!hasCalendar) {
      await replyFn('📅 Google Calendar 还没有接入，请先完成授权配置。');
      return;
    }
    const events = await listEvents(intent.queryText || text);
    if (!events) {
      await replyFn('查询日历时出了点问题 😅');
      return;
    }
    const label = text.includes('明天') ? '明天' : text.includes('本周') || text.includes('这周') ? '本周' : '今天';
    await replyFn(`📅 *${label}的日程：*\n${events}`);
    return;
  }

  // 创建日程
  if (intent.intent === 'calendar_create' && intent.summary && intent.startISO) {
    const hasCalendar = process.env.GOOGLE_CREDENTIALS && process.env.GOOGLE_TOKEN;
    if (!hasCalendar) {
      await replyFn('📅 Google Calendar 还没有接入，请先完成授权配置。');
      return;
    }
    // 默认结束时间 = 开始 + 1小时
    const endISO = intent.endISO || new Date(new Date(intent.startISO).getTime() + 3600000).toISOString();
    const event = await createEvent({ summary: intent.summary, startISO: intent.startISO, endISO, description: intent.description, location: intent.location });
    if (!event) {
      await replyFn('创建日程时出了点问题 😅');
      return;
    }
    const startTime = new Date(intent.startISO).toLocaleString('zh-CN', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    await replyFn(`✅ 日程已创建！\n*标题：* ${intent.summary}\n*时间：* ${startTime}${intent.location ? '\n*地点：* ' + intent.location : ''}`);
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
    await say({ text: '🗑️ 对话历史已清空', response_type: 'ephemeral' });
    return;
  }
  if (text === 'profile') {
    const profile = getProfile(command.user_id);
    const display = Object.keys(profile).length > 0 ? '```\n' + JSON.stringify(profile, null, 2) + '\n```' : '还没有学到任何偏好 🌱';
    await say({ text: `🧠 *当前用户画像：*\n${display}`, response_type: 'ephemeral' });
    return;
  }
  if (text === 'reset-profile') {
    db.prepare(`DELETE FROM user_profile WHERE user_id = ?`).run(command.user_id);
    await say({ text: '🗑️ 用户画像已清空', response_type: 'ephemeral' });
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
  console.log('⚡️ Claude Slack Bot 已启动（日历 + 提醒 + 自进化）');
})();
