import { handleCallback } from '@vercel/queue';
import { fireReminder } from './_core.js';

export const POST = handleCallback(async (message) => {
  await fireReminder(message.id);
});
