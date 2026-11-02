import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
import { getProfile, setProfileFields, getHistory, appendHistory, registerUser } from './_store.js';

const VOVO_SYSTEM_INSTRUCTION = `You are Vovo, an uncompromising, empathetic, and hyper-focused personal AI life coach.

CORE DIRECTIVES:
1. Speak directly, concisely, and punchily (1-4 short sentences per message).
2. NEVER do the work for the user. Give them clear, actionable steps and demand execution.
3. Call out fluff, excuses, and procrastination immediately.
4. Reference the user's specific stored goals and daily schedule to keep them accountable.
5. End most responses with a clear deadline question (e.g., "Will this be done by 3 PM? Yes or No?").
6. Keep formatting clean using Telegram Markdown formatting.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Vovo Engine Online.');
  }

  const { message, callback_query } = req.body;

  if (callback_query) {
    return handleCallback(callback_query, res);
  }

  if (!message || !message.text) {
    return res.status(200).send('OK');
  }

  const chatId = message.chat.id;
  const userText = message.text.trim();
  const userId = message.from.id.toString();

  try {
    
    const [profile, rawHistory] = await Promise.all([
      getProfile(userId),
      getHistory(userId, 10)
    ]);

    if (!profile || profile.chatId !== chatId.toString()) {
      await Promise.all([
        setProfileFields(userId, { chatId: chatId.toString(), name: message.from.first_name || 'Champ' }),
        registerUser(userId)
      ]);
    }

    if (userText.startsWith('/start')) {
      await sendTelegramMessage(chatId,
        "🔥 *I am Vovo.* I'm not here to hold your hand; I'm here to ensure you do what you said you would do.\n\n" +
        "Let's get started:\n" +
        "1. Send `/goals [Your main goals]`\n" +
        "2. Send `/schedule [Your key daily routine times]`\n" +
        "3. Send `/status` anytime to check in."
      );
      return res.status(200).json({ ok: true });
    }

    if (userText.startsWith('/goals')) {
      const goalsText = userText.replace('/goals', '').trim();
      if (!goalsText) {
        const currentGoals = profile?.goals || "No goals set yet!";
        await sendTelegramMessage(chatId, `🎯 *Your Stored Goals:*\n${currentGoals}\n\nTo update, send:\n\`/goals 1. Hit gym 4x/wk 2. Finish project by Friday\``);
      } else {
        await setProfileFields(userId, { goals: goalsText });
        await sendTelegramMessage(chatId, `✅ *Goals Locked In:*\n"${goalsText}"\n\nNo excuses now. I will hold you to this.`);
      }
      return res.status(200).json({ ok: true });
    }

    if (userText.startsWith('/schedule')) {
      const schedText = userText.replace('/schedule', '').trim();
      if (!schedText) {
        const currentSched = profile?.schedule || "No schedule set yet!";
        await sendTelegramMessage(chatId, `📅 *Your Daily Schedule:*\n${currentSched}\n\nTo update, send:\n\`/schedule 07:00 Morning Workout | 09:00 Deep Work | 22:00 Sleep\``);
      } else {
        await setProfileFields(userId, { schedule: schedText });
        await sendTelegramMessage(chatId, `⏱️ *Schedule Saved.* I will hold you accountable to these time slots.`);
      }
      return res.status(200).json({ ok: true });
    }

    if (userText.startsWith('/status')) {
      await sendAccountabilityCheck(chatId, profile?.goals || "Your targets");
      return res.status(200).json({ ok: true });
    }

    const userProfileText = `User Name: ${profile?.name || 'Champ'}\nGoals: ${profile?.goals || 'Not set'}\nSchedule: ${profile?.schedule || 'Not set'}`;

    const formattedHistory = rawHistory
      .map(entry => `${entry.role === 'user' ? 'User' : 'Vovo'}: ${entry.text}`)
      .join('\n');

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      systemInstruction: `${VOVO_SYSTEM_INSTRUCTION}\n\n=== USER PROFILE ===\n${userProfileText}`
    });

    const promptContext = formattedHistory
      ? `=== RECENT CHAT HISTORY ===\n${formattedHistory}\n\nUser: ${userText}`
      : userText;

    const result = await model.generateContent(promptContext);
    const vovoReply = result.response.text();

    await Promise.all([
      sendTelegramMessage(chatId, vovoReply),
      appendHistory(userId, [{ role: 'user', text: userText }, { role: 'vovo', text: vovoReply }])
    ]);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Vovo Processing Error:', error);
    try { await sendTelegramMessage(chatId, "⚠️ I glitched for a second — send that again."); } catch (e) { console.error('Fallback send failed:', e); }
    return res.status(200).json({ ok: false });
  }
}

async function handleCallback(query, res) {
  const chatId = query.message.chat.id;
  const action = query.data;

  let replyText = "";
  if (action === 'status_done') {
    replyText = "🔥 **Boom!** Action taken, excuses eliminated. What's the next task?";
  } else if (action === 'status_late') {
    replyText = "⏰ **Clock is ticking.** Stop overthinking. Give me 10 focused minutes right now.";
  } else if (action === 'status_slacking') {
    replyText = "❌ **Unacceptable.** Close the extra tabs, put your phone face down, and start NOW.";
  }

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: replyText, parse_mode: 'Markdown' })
  });

  return res.status(200).json({ ok: true });
}

async function sendTelegramMessage(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
  if (!r.ok) {
    console.error('Markdown send failed, retrying plain:', await r.text());
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  }
}

async function sendAccountabilityCheck(chatId, goals) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `⚡ **ACCOUNTABILITY CHECK**\n\nGoals: *${goals}*\n\nDid you complete your primary objective for this time block?`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Done", callback_data: "status_done" },
            { text: "⏳ Need 10 Mins", callback_data: "status_late" },
            { text: "❌ Slacking", callback_data: "status_slacking" }
          ]
        ]
      }
    })
  });
}
