export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, service: 'vovo-auth' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const password = (body?.password || '').trim();
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Password required' });
  }

  if (process.env.OWNER_PASSWORD && password === process.env.OWNER_PASSWORD) {
    return res.status(200).json({ ok: true, role: 'owner' });
  }
  if (process.env.MEMBER_CODE && password.toUpperCase() === process.env.MEMBER_CODE.toUpperCase()) {
    return res.status(200).json({ ok: true, role: 'member' });
  }

  return res.status(401).json({ ok: false, error: 'Invalid access code' });
}
