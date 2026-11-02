import {
  coach, sendMessage, tg, webLink, webhookSecret, encryptKey, validateGeminiKey, validTz, fmtLocal,
  sweepDueReminders, addReminder, getProfile, updateProfile, listReminders, cancelReminder, addKnowledge
} from './_core.js';
import { upsertUser, getReminder, LIMITS } from './_store.js';

const HELP =
  "🔥 *I am Vovo.* I'm not here to hold your hand; I'm here to make sure you do what you said you'd do.\n\n" +
  "Just talk to me. Say *\"I'll work out at 4\"* and I'll text you at 4.\n\n" +
  "*Commands*\n" +
  "/goals [your goals] — lock in goals\n" +
  "/schedule [routine] — your daily routine\n" +
  "/know [fact] — teach me about you\n" +
  "/reminders — see & cancel reminders\n" +
  "/web — open your Vovo web app\n" +
  "/key [AIza...] — use your own free Gemini key\n" +
  "/timezone [Area/City] — e.g. /timezone Asia/Jerusalem\n" +
  "/status — accountability check";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Vovo Engine Online.');
  if (process.env.WEB_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) {
    return res.status(401).send('Unauthorized');
  }
  const { message, callback_query } = req.body || {};
  try {
    if (callback_query) await handleCallback(callback_query);
    else if (message?.text) await handleMessage(message);
  } catch (error) {
    console.error('Vovo Processing Error:', error);
    const chatId = message?.chat?.id || callback_query?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, '⚠️ I glitched for a second — send that again.').catch(() => {});
  }
  sweepDueReminders().catch((e) => console.error('sweep', e.message));
  return res.status(200).json({ ok: true });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text.trim();
  await upsertUser(userId, { name: message.from.first_name || 'Champ', chatId: String(chatId) });
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = text.slice(cmd.length).trim();
  const command = cmd.startsWith('/') ? cmd.split('@')[0].toLowerCase() : null;

  switch (command) {
    case '/start':
    case '/help':
      if (arg === 'web') return sendWebLink(chatId, userId);
      return sendMessage(chatId, HELP);
    case '/web':
    case '/app':
      return sendWebLink(chatId, userId);
    case '/goals': {
      if (!arg) {
        const p = await getProfile(userId);
        return sendMessage(chatId, `🎯 *Your goals:*\n${p?.goals || 'None yet.'}\n\nUpdate: \`/goals Gym 4x/wk · Ship the site by Friday\``);
      }
      await updateProfile(userId, { goals: arg.slice(0, 600) });
      return sendMessage(chatId, `✅ *Goals locked in:*\n"${arg.slice(0, 600)}"\n\nNo excuses now. I will hold you to this.`);
    }
    case '/schedule': {
      if (!arg) {
        const p = await getProfile(userId);
        return sendMessage(chatId, `📅 *Your routine:*\n${p?.schedule || 'None yet.'}\n\nUpdate: \`/schedule 06:00 Wake | 09:00 Classes | 18:00 Build\``);
      }
      await updateProfile(userId, { schedule: arg.slice(0, 600) });
      return sendMessage(chatId, '⏱️ *Routine saved.* Tell me which ones you want pinged and I\'ll set daily reminders.');
    }
    case '/know': {
      if (!arg) return sendMessage(chatId, 'Teach me something about you: `/know I\'m vegan and start classes at 9`');
      const r = await addKnowledge(userId, [arg]);
      return sendMessage(chatId, r.added.length ? `🧠 Noted. I know ${r.list.length}/${LIMITS.knowledgeItems} things about you.` : r.full ? `🧠 Knowledge is full (${LIMITS.knowledgeItems}). Delete some in /web.` : '🧠 Already knew that.');
    }
    case '/knowledge': {
      const p = await getProfile(userId);
      const list = (p?.knowledge || []).map((k, i) => `${i + 1}. ${k.text}`).join('\n');
      return sendMessage(chatId, list ? `🧠 *What I know about you:*\n${list}\n\nEdit it in /web` : 'I don\'t know anything about you yet. Use `/know ...`');
    }
    case '/reminders': {
      const p = await getProfile(userId);
      const rems = await listReminders(userId);
      if (!rems.length) return sendMessage(chatId, 'No active reminders. Say something like "I\'ll go to the gym at 5" and I\'ll set one.');
      return sendMessage(chatId, '⏰ *Active reminders* — tap to cancel:', {
        reply_markup: { inline_keyboard: rems.slice(0, 20).map((r) => [{ text: `✖ ${fmtLocal(r.dueAt, p.timezone)}${r.repeat === 'daily' ? ' ↻' : ''} · ${r.text}`.slice(0, 60), callback_data: `rem_cancel:${r.id}` }]) }
      });
    }
    case '/key': {
      await tg('deleteMessage', { chat_id: chatId, message_id: message.message_id });
      if (!arg) return sendMessage(chatId, 'Send `/key AIza...` with your free Gemini key (get one at aistudio.google.com → Get API key). I delete the message right away.');
      if (arg.toLowerCase() === 'remove') { await updateProfile(userId, { geminiKeyEnc: null }); return sendMessage(chatId, '🔑 Key removed.'); }
      if (!(await validateGeminiKey(arg))) return sendMessage(chatId, '❌ That key didn\'t work. Copy it again from aistudio.google.com → Get API key.');
      await updateProfile(userId, { geminiKeyEnc: encryptKey(arg) });
      return sendMessage(chatId, '🔑 *Key connected* (encrypted, message deleted). Vovo now runs on your own free Gemini key.');
    }
    case '/timezone': {
      if (!arg || !validTz(arg)) return sendMessage(chatId, 'Send a valid timezone, e.g. `/timezone Asia/Jerusalem` or `/timezone America/New_York`');
      await updateProfile(userId, { timezone: arg });
      return sendMessage(chatId, `🌍 Timezone set to *${arg}*.`);
    }
    case '/status': {
      const p = await getProfile(userId);
      return sendMessage(chatId, `⚡ *ACCOUNTABILITY CHECK*\n\nGoals: *${p?.goals || 'Your targets'}*\n\nDid you complete your primary objective for this time block?`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Done', callback_data: 'status_done' },
          { text: '⏳ Need 10 Mins', callback_data: 'status_late' },
          { text: '❌ Slacking', callback_data: 'status_slacking' }
        ]] }
      });
    }
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  const { reply } = await coach(userId, text, 'telegram');
  await sendMessage(chatId, reply);
}

function sendWebLink(chatId, userId) {
  return sendMessage(chatId, '🖥️ *Your private Vovo web app* — chat, reminders and knowledge, synced with this chat. Don\'t share this link.', {
    reply_markup: { inline_keyboard: [[{ text: 'Open Vovo web app', url: webLink(userId) }]] }
  });
}

const STATUS_REPLIES = {
  status_done: "🔥 *Boom!* Action taken, excuses eliminated. What's the next task?",
  status_late: '⏰ *Clock is ticking.* Stop overthinking. Give me 10 focused minutes right now.',
  status_slacking: '❌ *Unacceptable.* Close the extra tabs, put your phone face down, and start NOW.'
};

async function handleCallback(q) {
  const chatId = q.message.chat.id;
  const userId = String(q.from.id);
  const [action, idStr] = String(q.data || '').split(':');
  const id = Number(idStr);
  await tg('answerCallbackQuery', { callback_query_id: q.id });

  if (STATUS_REPLIES[action]) return sendMessage(chatId, STATUS_REPLIES[action]);
  if (action === 'rem_done') return sendMessage(chatId, '🔥 That\'s execution. Report back when it\'s done.');
  if (action === 'rem_skip') return sendMessage(chatId, '❌ Skipping is a decision. What\'s the real reason — and when are you making it up?');
  if (action === 'rem_snooze') {
    const rem = await getReminder(id);
    const p = await getProfile(userId);
    if (!rem || rem.userId !== userId || !p) return;
    await addReminder(p, { dueAt: new Date(Date.now() + 10 * 60000), text: rem.text, repeat: 'none' });
    return sendMessage(chatId, '⏳ 10 minutes. Not 11. I\'ll be back.');
  }
  if (action === 'rem_cancel') {
    const ok = await cancelReminder(userId, id);
    return sendMessage(chatId, ok ? '🗑️ Reminder cancelled.' : 'That reminder is already gone.');
  }
}
