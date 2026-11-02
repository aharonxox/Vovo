// Web app API. Auth = signed link from the bot (/web).
import {
  coach, verifyWebToken, verifyInitData, webToken,  sendMessage, encryptKey, validateGeminiKey, validTz, fmtLocal, addReminder,
  sweepDueReminders, getProfile, updateProfile, listReminders, cancelReminder, addKnowledge, BOT_USERNAME
} from './_core.js';
import { getHistory, deleteKnowledge, upsertUser, LIMITS } from './_store.js';

async function snapshot(userId) {
  const [p, history, reminders] = await Promise.all([getProfile(userId), getHistory(userId), listReminders(userId)]);
  return {
    token: webToken(userId),
    profile: { name: p.name, goals: p.goals || '', schedule: p.schedule || '', timezone: p.timezone, tzSet: p.tzSet, hasOwnKey: !!p.geminiKeyEnc },
    knowledge: p.knowledge || [],
    reminders: reminders.map((r) => ({ ...r, local: fmtLocal(r.dueAt, p.timezone) })),
    history: history.map(({ role, text, src, ts }) => ({ role, text, src, ts })),
    limits: LIMITS,
    bot: BOT_USERNAME
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  let userId = verifyWebToken(body?.token);
  if (!userId && body?.initData) {
    const tgUser = verifyInitData(body.initData);
    if (tgUser) { userId = tgUser.id; await upsertUser(userId, { name: tgUser.name, chatId: userId }); }
  }
  if (!userId) return res.status(401).json({ error: 'Please open Vovo from Telegram to sign in.' });
  let profile = await getProfile(userId);
  if (profile && !profile.tzSet && validTz(body.browserTz)) {
    await updateProfile(userId, { timezone: body.browserTz });
    profile = await getProfile(userId);
  }
  if (!profile) return res.status(401).json({ error: 'Unknown user. Send /start to the bot first.' });
  sweepDueReminders().catch(() => {});

  try {
    switch (body.action) {
      case 'load':
        return res.json(await snapshot(userId));
      case 'chat': {
        const text = String(body.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Empty message' });
        const out = await coach(userId, text, 'web');
        for (const r of out.created) {
          await sendMessage(profile.chatId, `⏰ Reminder set from the web app: *${r.text}* — ${fmtLocal(r.dueAt, profile.timezone)}${r.repeat === 'daily' ? ' (daily)' : ''}`).catch(() => {});
        }
        return res.json({ reply: out.reply, learned: out.learned, ...(await snapshot(userId)) });
      }
      case 'knowledge_add': {
        const r = await addKnowledge(userId, [body.text]);
        if (!r.added.length) return res.status(400).json({ error: r.full ? `Knowledge is full (${LIMITS.knowledgeItems} notes). Delete one first.` : 'Already saved.' });
        return res.json(await snapshot(userId));
      }
      case 'knowledge_delete':
        await deleteKnowledge(userId, String(body.id));
        return res.json(await snapshot(userId));
      case 'reminder_add': {
        const due = new Date(body.at);
        if (!body.text || isNaN(due) || due.getTime() < Date.now()) return res.status(400).json({ error: 'Pick a future time and a label.' });
        const rem = await addReminder(profile, { dueAt: due, text: String(body.text).slice(0, 200), repeat: body.repeat });
        if (!rem) return res.status(400).json({ error: `Max ${LIMITS.pendingReminders} active reminders.` });
        await sendMessage(profile.chatId, `⏰ Reminder set: *${rem.text}* — ${fmtLocal(rem.dueAt, profile.timezone)}${rem.repeat === 'daily' ? ' (daily)' : ''}`).catch(() => {});
        return res.json(await snapshot(userId));
      }
      case 'reminder_cancel':
        await cancelReminder(userId, Number(body.id));
        return res.json(await snapshot(userId));
      case 'settings': {
        const f = {};
        if (typeof body.goals === 'string') f.goals = body.goals.slice(0, 600);
        if (typeof body.schedule === 'string') f.schedule = body.schedule.slice(0, 600);
        if (typeof body.name === 'string' && body.name.trim()) f.name = body.name.trim().slice(0, 60);
        if (typeof body.timezone === 'string') {
          if (!validTz(body.timezone)) return res.status(400).json({ error: 'Unknown timezone' });
          f.timezone = body.timezone;
        }
        if (body.removeKey) f.geminiKeyEnc = null;
        if (typeof body.geminiKey === 'string' && body.geminiKey.trim()) {
          if (!(await validateGeminiKey(body.geminiKey.trim()))) return res.status(400).json({ error: "That Gemini key didn't work — copy it again from AI Studio." });
          f.geminiKeyEnc = encryptKey(body.geminiKey.trim());
        }
        await updateProfile(userId, f);
        return res.json(await snapshot(userId));
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('app api', e);
    return res.status(500).json({ error: 'Vovo glitched — try again.' });
  }
}
