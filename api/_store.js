// Vovo storage — Neon Postgres (DATABASE_URL). All per-user data is capped to keep the DB small.
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

export const LIMITS = {
  history: 40,           // chat turns kept per user (Telegram + web combined)
  knowledgeItems: 25,    // notes per user
  knowledgeChars: 400,   // chars per note
  pendingReminders: 30,  // active reminders per user
  messageChars: 2000     // max inbound message length
};

let ready = null;
export function ensureSchema() {
  if (!ready) ready = (async () => {
    const tolerate = (e) => { if (!/already exists|pg_type_typname_nsp_index|duplicate/i.test(e.message)) throw e; };
    try {
      await sql`CREATE TABLE IF NOT EXISTS vovo_users (
        user_id TEXT PRIMARY KEY, name TEXT, chat_id TEXT, goals TEXT, schedule TEXT,
        history JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    } catch (e) { tolerate(e); }
    await sql`ALTER TABLE vovo_users ADD COLUMN IF NOT EXISTS timezone TEXT`;
    await sql`ALTER TABLE vovo_users ADD COLUMN IF NOT EXISTS knowledge JSONB NOT NULL DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE vovo_users ADD COLUMN IF NOT EXISTS gemini_key_enc TEXT`;
    try {
      await sql`CREATE TABLE IF NOT EXISTS vovo_reminders (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL, text TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    } catch (e) { tolerate(e); }
    try { await sql`CREATE INDEX IF NOT EXISTS vovo_reminders_due ON vovo_reminders (status, due_at)`; } catch (e) { tolerate(e); }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export const DEFAULT_TZ = 'Asia/Jerusalem';

export async function getProfile(userId) {
  await ensureSchema();
  const rows = await sql`SELECT user_id AS "userId", name, chat_id AS "chatId", goals, schedule,
    COALESCE(timezone, ${DEFAULT_TZ}) AS timezone, knowledge, gemini_key_enc AS "geminiKeyEnc"
    FROM vovo_users WHERE user_id = ${userId}`;
  return rows[0] || null;
}

export async function upsertUser(userId, { name = null, chatId = null } = {}) {
  await ensureSchema();
  await sql`INSERT INTO vovo_users (user_id, name, chat_id) VALUES (${userId}, ${name}, ${chatId})
    ON CONFLICT (user_id) DO UPDATE SET
      name = COALESCE(vovo_users.name, EXCLUDED.name),
      chat_id = COALESCE(EXCLUDED.chat_id, vovo_users.chat_id), updated_at = now()`;
}

export async function updateProfile(userId, f) {
  await ensureSchema();
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  if (has('name')) await sql`UPDATE vovo_users SET name = ${f.name}, updated_at = now() WHERE user_id = ${userId}`;
  if (has('goals')) await sql`UPDATE vovo_users SET goals = ${f.goals}, updated_at = now() WHERE user_id = ${userId}`;
  if (has('schedule')) await sql`UPDATE vovo_users SET schedule = ${f.schedule}, updated_at = now() WHERE user_id = ${userId}`;
  if (has('timezone')) await sql`UPDATE vovo_users SET timezone = ${f.timezone}, updated_at = now() WHERE user_id = ${userId}`;
  if (has('geminiKeyEnc')) await sql`UPDATE vovo_users SET gemini_key_enc = ${f.geminiKeyEnc}, updated_at = now() WHERE user_id = ${userId}`;
}

export async function getHistory(userId, count = LIMITS.history) {
  await ensureSchema();
  const rows = await sql`SELECT history FROM vovo_users WHERE user_id = ${userId}`;
  return (rows[0]?.history || []).slice(-count);
}

export async function appendHistory(userId, entries) {
  await ensureSchema();
  const add = JSON.stringify(entries);
  await sql`UPDATE vovo_users SET
    history = COALESCE((SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(history || ${add}::jsonb) e
      OFFSET GREATEST(jsonb_array_length(history || ${add}::jsonb) - ${LIMITS.history}, 0)) t), '[]'::jsonb),
    updated_at = now() WHERE user_id = ${userId}`;
}

export async function addKnowledge(userId, texts) {
  const profile = await getProfile(userId);
  const list = Array.isArray(profile?.knowledge) ? profile.knowledge : [];
  const added = [];
  for (const raw of texts) {
    const text = String(raw || '').trim().slice(0, LIMITS.knowledgeChars);
    if (!text || list.some((k) => k.text.toLowerCase() === text.toLowerCase())) continue;
    if (list.length >= LIMITS.knowledgeItems) break;
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, ts: new Date().toISOString() };
    list.push(item); added.push(item);
  }
  if (added.length) await sql`UPDATE vovo_users SET knowledge = ${JSON.stringify(list)}::jsonb, updated_at = now() WHERE user_id = ${userId}`;
  return { added, full: list.length >= LIMITS.knowledgeItems, list };
}

export async function deleteKnowledge(userId, id) {
  const profile = await getProfile(userId);
  const list = (profile?.knowledge || []).filter((k) => k.id !== id);
  await sql`UPDATE vovo_users SET knowledge = ${JSON.stringify(list)}::jsonb, updated_at = now() WHERE user_id = ${userId}`;
  return list;
}

export async function allUsers() {
  await ensureSchema();
  return await sql`SELECT user_id AS "userId", name, chat_id AS "chatId", goals FROM vovo_users WHERE chat_id IS NOT NULL`;
}

// ---- reminders ----
export async function createReminder({ userId, chatId, dueAt, text, repeat = 'none' }) {
  await ensureSchema();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM vovo_reminders WHERE user_id = ${userId} AND status = 'pending'`;
  if (n >= LIMITS.pendingReminders) return null;
  const rows = await sql`INSERT INTO vovo_reminders (user_id, chat_id, due_at, text, repeat)
    VALUES (${userId}, ${chatId}, ${dueAt.toISOString()}, ${String(text).slice(0, 200)}, ${repeat === 'daily' ? 'daily' : 'none'})
    RETURNING id, due_at AS "dueAt", text, repeat`;
  return rows[0];
}

export async function listReminders(userId) {
  await ensureSchema();
  return await sql`SELECT id, due_at AS "dueAt", text, repeat FROM vovo_reminders
    WHERE user_id = ${userId} AND status = 'pending' ORDER BY due_at LIMIT ${LIMITS.pendingReminders}`;
}

export async function cancelReminder(userId, id) {
  await ensureSchema();
  const rows = await sql`UPDATE vovo_reminders SET status = 'cancelled' WHERE id = ${id} AND user_id = ${userId} AND status = 'pending' RETURNING id`;
  return rows.length > 0;
}

export async function getReminder(id) {
  await ensureSchema();
  const rows = await sql`SELECT id, user_id AS "userId", chat_id AS "chatId", due_at AS "dueAt", text, repeat, status FROM vovo_reminders WHERE id = ${id}`;
  return rows[0] || null;
}

// Atomically claim a due reminder so it is delivered once even if triggered from several places.
export async function claimDueReminder(id) {
  const rows = await sql`UPDATE vovo_reminders SET status = 'firing'
    WHERE id = ${id} AND status = 'pending' AND due_at <= now() + interval '30 seconds'
    RETURNING id, user_id AS "userId", chat_id AS "chatId", due_at AS "dueAt", text, repeat`;
  return rows[0] || null;
}

export async function finishReminder(id, nextDueAt) {
  if (nextDueAt) await sql`UPDATE vovo_reminders SET status = 'pending', due_at = ${nextDueAt.toISOString()} WHERE id = ${id}`;
  else await sql`UPDATE vovo_reminders SET status = 'sent' WHERE id = ${id}`;
}

export async function dueReminderIds(limit = 25) {
  await ensureSchema();
  await sql`UPDATE vovo_reminders SET status = 'pending' WHERE status = 'firing' AND due_at < now() - interval '10 minutes'`;
  const rows = await sql`SELECT id FROM vovo_reminders WHERE status = 'pending' AND due_at <= now() ORDER BY due_at LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

export async function pruneOldReminders() {
  await sql`DELETE FROM vovo_reminders WHERE status IN ('sent','cancelled') AND created_at < now() - interval '14 days'`;
}
