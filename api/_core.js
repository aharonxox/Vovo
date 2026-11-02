// Vovo brain shared by Telegram, the web app and the reminder queue.
import crypto from 'node:crypto';
import { send } from '@vercel/queue';
import {
  LIMITS, DEFAULT_TZ, getProfile, updateProfile, getHistory, appendHistory, addKnowledge,
  createReminder, listReminders, cancelReminder, getReminder, claimDueReminder, finishReminder, dueReminderIds
} from './_store.js';

export const SITE = process.env.SITE_URL || 'https://vovo-coach.vercel.app';
export const BOT_USERNAME = process.env.BOT_USERNAME || 'vovo_aharonenterprise_bot';
const SECRET = process.env.WEB_SECRET || '';

// ---------- web identity (signed link sent by the bot) ----------
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
export function webToken(userId) { return `${Buffer.from(userId).toString('base64url')}.${hmac('web:' + userId).slice(0, 32)}`; }
export function verifyWebToken(token) {
  const [a, sig] = String(token || '').split('.');
  if (!a || !sig || !SECRET) return null;
  const userId = Buffer.from(a, 'base64url').toString();
  const good = hmac('web:' + userId).slice(0, 32);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? userId : null;
}
// Telegram Mini App sign-in: initData is signed by Telegram with our bot token.
export function verifyInitData(initData, maxAgeSec = 7 * 86400) {
  try {
    const params = new URLSearchParams(String(initData || ''));
    const hash = params.get('hash');
    if (!hash || !process.env.TELEGRAM_TOKEN) return null;
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_TOKEN).digest();
    const good = crypto.createHmac('sha256', key).update(check).digest('hex');
    if (good.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > maxAgeSec) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? { id: String(user.id), name: user.first_name || null } : null;
  } catch { return null; }
}
export const webLink = (userId) => `${SITE}/app.html#t=${webToken(userId)}`;
export const webhookSecret = () => hmac('telegram-webhook').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);

// ---------- Gemini key encryption ----------
const encKey = () => crypto.createHash('sha256').update(SECRET + ':gemini-key').digest();
export function encryptKey(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
function decryptKey(enc) {
  try {
    const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return null; }
}
export async function validateGeminiKey(key) {
  if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(key)) return false;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`);
  return r.ok;
}

// ---------- Telegram ----------
const tgApi = (method) => `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`;
export async function tg(method, body) {
  const r = await fetch(tgApi(method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}
export async function sendMessage(chatId, text, extra = {}) {
  const md = String(text).replace(/\*\*(.+?)\*\*/g, '*$1*');
  const r = await tg('sendMessage', { chat_id: chatId, text: md, parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });
  if (r.ok) return r;
  return tg('sendMessage', { chat_id: chatId, text: String(text).replace(/\*\*/g, ''), disable_web_page_preview: true, ...extra });
}

// ---------- time helpers ----------
export function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
export function fmtLocal(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
}
function nowContext(tz) {
  const d = new Date();
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long' }).format(d);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  return `${local} (${tz}, ${offset === 'GMT' ? 'GMT+00:00' : offset})`;
}

// ---------- reminder scheduling (Vercel Queues, delayed delivery) ----------
const MAX_DELAY = 604800 - 300;
export async function enqueueReminder(id, dueAt) {
  const delay = Math.max(0, Math.min(MAX_DELAY, Math.ceil((new Date(dueAt).getTime() - Date.now()) / 1000)));
  try {
    await send('vovo-reminders', { id: String(id) }, {
      delaySeconds: delay, retentionSeconds: 604800, idempotencyKey: `rem-${id}-${new Date(dueAt).getTime()}`
    });
  } catch (e) { console.error('enqueue failed (sweep will catch it):', e.message); }
}

export async function addReminder(profile, { dueAt, text, repeat }) {
  const rem = await createReminder({ userId: profile.userId, chatId: profile.chatId, dueAt, text, repeat });
  if (rem) await enqueueReminder(rem.id, rem.dueAt);
  return rem;
}

export async function fireReminder(id) {
  const rem = await getReminder(id);
  if (!rem || rem.status !== 'pending') return 'skip';
  if (new Date(rem.dueAt).getTime() - Date.now() > 30000) { await enqueueReminder(rem.id, rem.dueAt); return 'requeued'; }
  const claimed = await claimDueReminder(rem.id);
  if (!claimed) return 'skip';
  await sendMessage(claimed.chatId, `⏰ *Time:* ${claimed.text}\n\nNo negotiating. Are you on it?`, {
    reply_markup: { inline_keyboard: [[
      { text: '✅ On it', callback_data: `rem_done:${claimed.id}` },
      { text: '⏳ 10 min', callback_data: `rem_snooze:${claimed.id}` },
      { text: '❌ Skipping', callback_data: `rem_skip:${claimed.id}` }
    ]] }
  });
  let next = null;
  if (claimed.repeat === 'daily') {
    next = new Date(claimed.dueAt);
    while (next.getTime() <= Date.now()) next = new Date(next.getTime() + 86400000);
  }
  await finishReminder(claimed.id, next);
  if (next) await enqueueReminder(claimed.id, next);
  return 'sent';
}

export async function sweepDueReminders() {
  const ids = await dueReminderIds();
  for (const id of ids) { try { await fireReminder(id); } catch (e) { console.error('sweep', id, e.message); } }
  return ids.length;
}

// ---------- the coach ----------
const SYSTEM = `You are Vovo, a warm, upbeat personal AI life coach that lives in the user's web app and texts them on Telegram.
STYLE: short and happy — 1-3 SHORT sentences, simple words a kid could read, never walls of text. Be warm and encouraging, celebrate small wins, nudge gently toward the next action. Use their name sometimes. Emoji ok, 1 max per message.
PERSONA: If PERSONALITY below is set, act exactly like that while staying Vovo. If the user asks to change how you act/talk ("be tougher", "act like a gentle friend", "talk like a pirate"), do it AND echo the new style in "persona" (a short third-person description, max 80 chars). Otherwise omit "persona".
REMINDERS: You can text the user on Telegram at exact times. Whenever the user states a time-bound intention ("I'll work out at 4", "wake me at 6", "remind me to call mom tomorrow 7pm") or a routine ("every day at 9 classes"), add an entry to "reminders". Use the user's timezone and the current local time given below; "at 4" means the NEXT upcoming 4 o'clock that makes sense for the activity. "at" MUST be ISO-8601 with the user's UTC offset. repeat = "daily" only for daily routines, else "none". Reminder text is a short, punchy coach nudge (max 80 chars). Never invent reminders the user didn't imply. To cancel, put the reminder id in "cancel_reminder_ids".
MEMORY: When the user reveals a durable personal fact (location, diet, job, routine, preferences, constraints, goals), add a concise third-person note to "remember" (max 120 chars each). Don't repeat facts already in KNOWLEDGE.
OUTPUT: JSON only: {"reply": string, "reminders": [{"at": string, "text": string, "repeat": "none"|"daily"}], "cancel_reminder_ids": [number], "remember": [string], "persona"?: string}. Do not mention reminders in "reply" — the system confirms them automatically.`;

const MODELS = () => [...new Set([process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].filter(Boolean))];

async function gemini(apiKey, system, prompt) {
  let lastErr;
  for (const model of MODELS()) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
      })
    });
    if (r.ok) {
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      try { return JSON.parse(text); } catch { return { reply: text }; }
    }
    lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
    if (![404, 429, 500, 503].includes(r.status)) break;
  }
  throw new Error(lastErr || 'Gemini failed');
}

export async function coach(userId, rawText, source) {
  const text = String(rawText || '').slice(0, LIMITS.messageChars);
  const [profile, history, reminders] = await Promise.all([getProfile(userId), getHistory(userId, 12), listReminders(userId)]);
  const tz = profile.timezone || DEFAULT_TZ;
  const ownKey = profile.geminiKeyEnc ? decryptKey(profile.geminiKeyEnc) : null;
  const knowledge = (profile.knowledge || []).map((k) => `- ${k.text}`).join('\n') || '(none yet)';
  const remList = reminders.map((r) => `#${r.id} ${fmtLocal(r.dueAt, tz)} ${r.repeat === 'daily' ? '(daily) ' : ''}${r.text}`).join('\n') || '(none)';
  const system = `${SYSTEM}\n\n=== USER ===\nName: ${profile.name || 'friend'}\nGoals: ${profile.goals || 'Not set'}\nSchedule: ${profile.schedule || 'Not set'}\nCurrent local time: ${nowContext(tz)}\nPERSONALITY: ${profile.persona || 'default — warm, upbeat, encouraging coach'}\n\n=== KNOWLEDGE ===\n${knowledge}\n\n=== ACTIVE REMINDERS ===\n${remList}`;
  const convo = history.map((h) => `${h.role === 'user' ? 'User' : 'Vovo'}: ${h.text}`).join('\n');
  const prompt = convo ? `=== RECENT CHAT ===\n${convo}\n\nUser: ${text}` : `User: ${text}`;

  const out = await gemini(ownKey || process.env.GEMINI_API_KEY, system, prompt);
  const created = [];
  for (const r of (Array.isArray(out.reminders) ? out.reminders : []).slice(0, 5)) {
    const due = new Date(r.at);
    if (!r.text || isNaN(due) || due.getTime() < Date.now() - 60000 || due.getTime() > Date.now() + 366 * 86400000) continue;
    // No phone connected yet (site member who hasn't done the one-time link) → skip quietly;
    // the app shows a "connect your phone" card instead.
    const rem = profile.chatId ? await addReminder(profile, { dueAt: due, text: r.text, repeat: r.repeat }) : null;
    if (rem) created.push(rem);
  }
  const cancelled = [];
  for (const id of (Array.isArray(out.cancel_reminder_ids) ? out.cancel_reminder_ids : []).slice(0, 10)) {
    if (await cancelReminder(userId, Number(id))) cancelled.push(Number(id));
  }
  if (typeof out.persona === 'string' && out.persona.trim()) {
    await updateProfile(userId, { persona: out.persona.trim().slice(0, 200) });
  }
  const learned = Array.isArray(out.remember) && out.remember.length ? (await addKnowledge(userId, out.remember.slice(0, 3))).added : [];

  let reply = String(out.reply || "Say that again — I'm listening.").trim();
  const notes = [
    ...created.map((r) => `⏰ Set: ${r.text} — ${fmtLocal(r.dueAt, tz)}${r.repeat === 'daily' ? ' (daily)' : ''}`),
    ...cancelled.map((id) => `🗑️ Cancelled reminder #${id}`)
  ];
  const full = notes.length ? `${reply}\n\n${notes.join('\n')}` : reply;
  const ts = new Date().toISOString();
  await appendHistory(userId, [{ role: 'user', text, src: source, ts }, { role: 'vovo', text: full, src: source, ts }]);
  return { reply: full, created, cancelled, learned, usingOwnKey: !!ownKey };
}

export { getProfile, updateProfile, listReminders, cancelReminder, addKnowledge };
