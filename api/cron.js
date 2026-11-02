import { sendMessage, sweepDueReminders } from './_core.js';
import { allUsers, pruneOldReminders } from './_store.js';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const swept = await sweepDueReminders();
    await pruneOldReminders();
    const users = await allUsers();
    for (const u of users) {
      await sendMessage(u.chatId, `🚨 *VOVO AUDIT*: Daily check, *${u.name || 'Champ'}*.\n\nTarget: *${u.goals || 'Execution'}*\n\nWhat are you executing today? Tell me the times and I'll hold you to them.`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Executing', callback_data: 'status_done' },
          { text: '⏱️ Delayed', callback_data: 'status_late' },
          { text: '❌ Off Track', callback_data: 'status_slacking' }
        ]] }
      }).catch((e) => console.error('audit send', e.message));
    }
    return res.status(200).json({ success: true, processed: users.length, swept });
  } catch (error) {
    console.error('Cron Execution Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
