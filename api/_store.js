// Storage layer for Vovo. Priority: Upstash Redis -> Neon Postgres (DATABASE_URL) -> kvdb.io (KVDB_URL).

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = await import('@upstash/redis');
  redis = Redis.fromEnv();
}

let sql = null;
if (!redis && process.env.DATABASE_URL) {
  const { neon } = await import('@neondatabase/serverless');
  sql = neon(process.env.DATABASE_URL);
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS vovo_users (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    chat_id TEXT,
    goals TEXT,
    schedule TEXT,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  tableReady = true;
}

const KV = process.env.KVDB_URL;
async function kvGet(key) {
  const r = await fetch(`${KV}/${encodeURIComponent(key)}`);
  if (r.status === 404) return null;
  return r.ok ? r.text() : null;
}
async function kvSet(key, value) {
  await fetch(`${KV}/${encodeURIComponent(key)}`, { method: 'POST', body: value });
}

export async function getProfile(userId) {
  if (redis) return await redis.hgetall(`vovo:user:${userId}:profile`) || {};
  if (sql) {
    await ensureTable();
    const rows = await sql`SELECT name, chat_id AS "chatId", goals, schedule FROM vovo_users WHERE user_id = ${userId}`;
    return rows[0] || {};
  }
  const raw = await kvGet(`vovo:user:${userId}:profile`);
  return raw ? JSON.parse(raw) : {};
}

export async function setProfileFields(userId, fields) {
  if (redis) return await redis.hset(`vovo:user:${userId}:profile`, fields);
  if (sql) {
    await ensureTable();
    await sql`INSERT INTO vovo_users (user_id, name, chat_id, goals, schedule)
      VALUES (${userId}, ${fields.name ?? null}, ${fields.chatId ?? null}, ${fields.goals ?? null}, ${fields.schedule ?? null})
      ON CONFLICT (user_id) DO UPDATE SET
        name = COALESCE(${fields.name ?? null}, vovo_users.name),
        chat_id = COALESCE(${fields.chatId ?? null}, vovo_users.chat_id),
        goals = COALESCE(${fields.goals ?? null}, vovo_users.goals),
        schedule = COALESCE(${fields.schedule ?? null}, vovo_users.schedule),
        updated_at = now()`;
    return;
  }
  const profile = await getProfile(userId);
  await kvSet(`vovo:user:${userId}:profile`, JSON.stringify({ ...profile, ...fields }));
}

export async function getHistory(userId, count = 10) {
  if (redis) {
    const items = await redis.lrange(`vovo:user:${userId}:history`, -count, -1);
    return items.map(i => (typeof i === 'string' ? JSON.parse(i) : i));
  }
  if (sql) {
    await ensureTable();
    const rows = await sql`SELECT history FROM vovo_users WHERE user_id = ${userId}`;
    return (rows[0]?.history || []).slice(-count);
  }
  const raw = await kvGet(`vovo:user:${userId}:history`);
  return (raw ? JSON.parse(raw) : []).slice(-count);
}

export async function appendHistory(userId, entries, keep = 20) {
  if (redis) {
    const key = `vovo:user:${userId}:history`;
    for (const e of entries) await redis.rpush(key, JSON.stringify(e));
    return await redis.ltrim(key, -keep, -1);
  }
  if (sql) {
    await ensureTable();
    await sql`UPDATE vovo_users SET
      history = (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(history || ${JSON.stringify(entries)}::jsonb) e OFFSET GREATEST(jsonb_array_length(history || ${JSON.stringify(entries)}::jsonb) - ${keep}, 0)) t),
      updated_at = now()
      WHERE user_id = ${userId}`;
    return;
  }
  const history = await getHistory(userId, keep);
  await kvSet(`vovo:user:${userId}:history`, JSON.stringify([...history, ...entries].slice(-keep)));
}

export async function allUserProfiles() {
  if (redis) {
    const keys = await redis.keys('vovo:user:*:profile');
    const out = [];
    for (const k of keys) out.push(await redis.hgetall(k));
    return out;
  }
  if (sql) {
    await ensureTable();
    return await sql`SELECT name, chat_id AS "chatId", goals, schedule FROM vovo_users`;
  }
  const raw = await kvGet('vovo:users');
  const ids = raw ? JSON.parse(raw) : [];
  const profiles = [];
  for (const id of ids) profiles.push(await getProfile(id));
  return profiles;
}

export async function registerUser(userId) {
  if (redis || sql) return;
  const raw = await kvGet('vovo:users');
  const ids = raw ? JSON.parse(raw) : [];
  if (!ids.includes(userId)) {
    ids.push(userId);
    await kvSet('vovo:users', JSON.stringify(ids));
  }
}
