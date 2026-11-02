import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const userKeys = await redis.keys('vovo:user:*:profile');

    for (const key of userKeys) {
      const profile = await redis.hgetall(key);

      if (profile && profile.chatId) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: profile.chatId,
            text: `🚨 **VOVO AUDIT**: Standard time check, *${profile.name || 'Champ'}*.\n\nTarget Goals: *${profile.goals || 'Execution'}*\n\nAre you executing right now or making excuses?`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Executing", callback_data: "status_done" },
                  { text: "⏱️ Delayed", callback_data: "status_late" },
                  { text: "❌ Off Track", callback_data: "status_slacking" }
                ]
              ]
            }
          })
        });
      }
    }

    return res.status(200).json({ success: true, processed: userKeys.length });
  } catch (error) {
    console.error('Cron Execution Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
