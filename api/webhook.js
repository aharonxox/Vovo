import {
  coach, sendMessage, tg, webLink, SITE, webhookSecret, encryptKey, validateGeminiKey, validTz, fmtLocal,
  sweepDueReminders, addReminder, getProfile, updateProfile, listReminders, cancelReminder, addKnowledge
} from './_core.js';
import { upsertUser, getReminder, LIMITS } from './_store.js';

const APP_URL = `${SITE}/app.html`;
const appButton = (label = '📱 Open my Vovo app') => ({ text: label, web_app: { url: APP_URL } });

const WELCOME = (name) =>
  `👋 *Hey ${name}, I'm Vovo — your personal coach.*\n\n` +
  "No commands needed. Just text me like a friend:\n\n" +
  "• _\"I want to work out at 4\"_ → I'll text you at 4\n" +
  "• _\"Wake me up every day at 6\"_ → daily reminder\n" +
  "• _\"I'm vegan and I work nights\"_ → I'll remember it\n\n" +
  "Tap a button below to start 👇";

const WELCOME_KEYS = {
  inline_keyboard: [
    [appButton()],
    [{ text: '🔑 Connect my free AI key (1 min)', callback_data: 'help_key' }],
    [{ text: '❓ How does Vovo work?', callback_data: 'help_how' }]
  ]
};

const HOW =
  "*How Vovo works*\n\n" +
  "1️⃣ *Tell me your plans* — \"gym at 5\", \"study at 8 tonight\". I'll text you at that exact time.\n" +
  "2️⃣ *Tap a button* when I check in: ✅ On it · ⏳ 10 min · ❌ Skip.\n" +
  "3️⃣ *Tell me about yourself* — I remember your goals, routine and habits.\n" +
  "4️⃣ *Open the app* (button below or the *Vovo* button next to where you type) to see your reminders and everything I know about you.\n\n" +
  "Change your mind? Just say \"cancel my gym reminder\".";

const KEY_HELP =
  "*🔑 Connect your free AI key — 1 minute*\n\n" +
  "1. Tap *Get my free key* below\n" +
  "2. Sign in with your Google account\n" +
  "3. Tap *Create API key*, then *Copy*\n" +
  "4. Come back here and *paste it in this chat*\n\n" +
  "That's it — I'll delete your message right away and keep the key locked. It's free from Google, no card needed.";

const KEY_KEYS = { inline_keyboard: [[{ text: '🔗 Get my free key', url: 'https://aistudio.google.com/apikey' }]] };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Vovo Engine Online.');
  if (process.env.WEB_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) {
    return res.status(401).send('Unauthorized');
  }
  const { message, callback_query } = req.body || {};
  try {
    if (callback_query) await handleCallback(callback_query);
    else if (message?.text) await handleMessage(message);
    else if (message?.chat?.type === 'private') await sendMessage(message.chat.id, "🙏 I can only read typed messages for now — just type it out and I've got you.");
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

  if (!command && /^AIza[0-9A-Za-z_-]{30,}$/.test(text)) return connectKey(chatId, userId, message.message_id, text);

  switch (command) {
    case '/start':
      return sendMessage(chatId, WELCOME(message.from.first_name || 'there'), { reply_markup: WELCOME_KEYS });
    case '/help':
      return sendMessage(chatId, HOW, { reply_markup: { inline_keyboard: [[appButton()], [{ text: '🔑 Connect my free AI key', callback_data: 'help_key' }]] } });
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
      return sendMessage(chatId, r.added.length ? `🧠 Noted. I know ${r.list.length}/${LIMITS.knowledgeItems} things about you.` : r.full ? `🧠 Knowledge is full (${LIMITS.knowledgeItems}). Open the app to delete some.` : '🧠 Already knew that.');
    }
    case '/knowledge': {
      const p = await getProfile(userId);
      const list = (p?.knowledge || []).map((k, i) => `${i + 1}. ${k.text}`).join('\n');
      return sendMessage(chatId, list ? `🧠 *What I know about you:*\n${list}\n\nYou can edit this in the app.` : 'I don\'t know anything about you yet. Just tell me about yourself in chat.');
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
      if (!arg) return sendMessage(chatId, KEY_HELP, { reply_markup: KEY_KEYS });
      if (arg.toLowerCase() === 'remove') { await updateProfile(userId, { geminiKeyEnc: null }); return sendMessage(chatId, '🔑 Key removed.'); }
      return connectKey(chatId, userId, message.message_id, arg);
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

async function connectKey(chatId, userId, messageId, key) {
  await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
  if (!(await validateGeminiKey(key.trim()))) {
    return sendMessage(chatId, "❌ Hmm, that key didn't work. Make sure you copied the whole thing (it starts with *AIza*) and paste it again.", { reply_markup: KEY_KEYS });
  }
  await updateProfile(userId, { geminiKeyEnc: encryptKey(key.trim()) });
  return sendMessage(chatId, "✅ *You're all set!* Your free AI key is connected and locked away (I deleted your message).\n\nNow tell me: what's one thing you want to get done today, and when?");
}

function sendWebLink(chatId, userId) {
  return sendMessage(chatId, '📱 *Your Vovo app* — chat, reminders and everything I know about you.\n\n*Want it on your iPhone home screen?* Tap *Open in Safari*, then tap the Share button ⬆️ → *Add to Home Screen*. (Private link — don\'t share it.)', {
    reply_markup: { inline_keyboard: [[appButton()], [{ text: '🧭 Open in Safari (for Home Screen)', url: webLink(userId) }]] }
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

  if (action === 'help_key') return sendMessage(chatId, KEY_HELP, { reply_markup: KEY_KEYS });
  if (action === 'help_how') return sendMessage(chatId, HOW, { reply_markup: { inline_keyboard: [[appButton()]] } });
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
