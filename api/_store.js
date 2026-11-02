// Storage layer: uses Upstash Redis when configured, otherwise a free
// kvdb.io bucket (KVDB_URL env). Swap later without touching handlers.

const KV = process.env.KVDB_URL; // e.g. https://kvdb.io/xxxxxxxx

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = await import('@upstash/redis');
  redis = Redis.fromEnv();
}

async function kvGet(key) {
  const r = await fetch(`${KV}/${encodeURIComponent(key)}`);
  if (r.status === 404) return null;
  return r.ok ? r.text() : null;
}
async function kvSet(key, value) {
  await fetch(`${KV}/${encodeURIComponent(key)}`, { method: 'POST', body: value });
}

export async function getProfile(userId) {
  const key = `vovo:user:${userId}:profile`;
  if (redis) return await redis.hgetall(key) || {};
  const raw = await kvGet(key);
  return raw ? JSON.parse(raw) : {};
}

export async function setProfileFields(userId, fields) {
  const key = `vovo:user:${userId}:profile`;
  if (redis) return await redis.hset(key, fields);
  const profile = await getProfile(userId);
  await kvSet(key, JSON.stringify({ ...profile, ...fields }));
}

export async function getHistory(userId, count = 10) {
  const key = `vovo:user:${userId}:history`;
  if (redis) {
    const items = await redis.lrange(key, -count, -1);
    return items.map(i => (typeof i === 'string' ? JSON.parse(i) : i));
  }
  const raw = await kvGet(key);
  const list = raw ? JSON.parse(raw) : [];
  return list.slice(-count);
}

export async function appendHistory(userId, entries, keep = 20) {
  const key = `vovo:user:${userId}:history`;
  if (redis) {
    for (const e of entries) await redis.rpush(key, JSON.stringify(e));
    return await redis.ltrim(key, -keep, -1);
  }
  const history = await getHistory(userId, keep);
  const list = [...history, ...entries].slice(-keep);
  await kvSet(key, JSON.stringify(list));
}

export async function allUserProfiles() {
  if (redis) {
    const keys = await redis.keys('vovo:user:*:profile');
    const out = [];
    for (const k of keys) out.push(await redis.hgetall(k));
    return out;
  }
  // kvdb.io can't list keys — keep a registry of user ids
  const raw = await kvGet('vovo:users');
  const ids = raw ? JSON.parse(raw) : [];
  const profiles = [];
  for (const id of ids) profiles.push(await getProfile(id));
  return profiles;
}

export async function registerUser(userId) {
  if (redis) return; // keys() scan covers registration implicitly
  const raw = await kvGet('vovo:users');
  const ids = raw ? JSON.parse(raw) : [];
  if (!ids.includes(userId)) {
    ids.push(userId);
    await kvSet('vovo:users', JSON.stringify(ids));
  }
}
