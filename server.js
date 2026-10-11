require('dotenv').config();
const express = require('express'), fs = require('fs'), crypto = require('crypto');
const E = process.env, DBF = 'db.json';
let db = { users: {}, chats: [], ann: '', ad: '' };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DBF)) }; } catch {}
const save = () => fs.writeFile(DBF, JSON.stringify(db), () => {});
const rid = () => crypto.randomBytes(16).toString('hex');
const sess = {}, admins = new Set(), live = {}, geo = {}, rate = {};

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

async function where(ip) {
  ip = (ip || '').replace('::ffff:', '');
  if (geo[ip]) return geo[ip];
  try {
    const r = await (await fetch(`http://ip-api.com/json/${ip}?fields=city,country`)).json();
    return (geo[ip] = r.country ? `${r.city}, ${r.country}` : 'Local / Unknown');
  } catch { return 'Unknown'; }
}
async function newUser(name, type, key, ip) {
  const u = db.users[key] || (db.users[key] = { id: key, name, type, joined: Date.now() });
  u.loc = await where(ip); u.last = Date.now(); save();
  const t = rid(); sess[t] = u.id;
  return { token: t, user: { id: u.id, name: u.name, type: u.type } };
}
const auth = (req, res, next) => {
  const u = db.users[sess[(req.headers.authorization || '').slice(7)]];
  if (!u) return res.status(401).json({ error: 'Please sign in again' });
  const now = Date.now(), r = rate[u.id] = (rate[u.id] || []).filter(t => now - t < 60000);
  if (req.method === 'POST' && req.path !== '/ping' && r.length >= 20) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  r.push(now);
  live[u.id] = { ...live[u.id], t: now };
  req.u = u; next();
};
const adminOnly = (req, res, next) => admins.has(req.headers['x-admin']) ? next() : res.status(403).json({ error: 'Admin only' });
const wrap = f => (req, res) => f(req, res).catch(e => res.status(500).json({ error: e.message }));

app.get('/api/config', (_, res) => res.json({ ann: db.ann, ad: db.ad, gid: E.GOOGLE_CLIENT_ID || '', discord: E.DISCORD_URL || 'https://discord.com' }));
app.post('/api/guest', wrap(async (req, res) => {
  const id = 'guest-' + rid().slice(0, 6);
  res.json(await newUser('Guest ' + id.slice(6), 'guest', id, req.ip));
}));
app.post('/api/google', wrap(async (req, res) => {
  const j = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential))).json();
  if (!j.sub || j.aud !== E.GOOGLE_CLIENT_ID) throw new Error('Google sign-in failed');
  res.json(await newUser(j.name || j.email, 'google', 'g' + j.sub, req.ip));
}));
app.get('/api/me', auth, (req, res) => res.json({ name: req.u.name, type: req.u.type }));
app.post('/api/ping', auth, (req, res) => { live[req.u.id].mode = req.body.mode; res.json({ ok: 1 }); });

// ---- AI providers: chat+image -> Gemini, code -> Groq, video -> HeyGen ----
async function gemini(model, body) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': E.GEMINI_API_KEY }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Gemini error');
  return j;
}
async function groq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.GROQ_API_KEY },
    body: JSON.stringify({ model: E.GROQ_MODEL || 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: 'You are an expert programmer. Give working, clean code in fenced code blocks with a short explanation.' }, ...messages] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Groq error');
  return j.choices[0].message.content;
}
const log = (u, mode, q, a) => {
  const c = { id: rid(), uid: u.id, name: u.name, loc: u.loc, mode, q, a, t: Date.now(), saved: false };
  db.chats.push(c); if (db.chats.length > 5000) db.chats.shift(); save(); live[u.id].mode = mode; return c;
};

app.post('/api/gen', auth, wrap(async (req, res) => {
  const { mode, messages } = req.body, last = messages[messages.length - 1].content;
  let a, img;
  if (mode === 'code') a = await groq(messages);
  else if (mode === 'image') {
    const j = await gemini(E.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image', { contents: [{ parts: [{ text: last }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
    const p = j.candidates?.[0]?.content?.parts || [], d = p.find(x => x.inlineData || x.inline_data);
    if (!d) throw new Error(p.map(x => x.text).join(' ') || 'No image returned. Try a different prompt.');
    const i = d.inlineData || d.inline_data; img = `data:${i.mimeType || i.mime_type};base64,${i.data}`; a = '[Image generated]';
  } else {
    const j = await gemini(E.GEMINI_CHAT_MODEL || 'gemini-2.5-flash', { contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })) });
    a = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!a) throw new Error('Empty reply. Try rephrasing.');
  }
  const c = log(req.u, mode, last, a);
  res.json({ text: img ? '' : a, img, id: c.id });
}));

const HG = (p, o = {}) => fetch('https://api.heygen.com' + p, { ...o, headers: { 'X-Api-Key': E.HEYGEN_API_KEY, 'Content-Type': 'application/json' } }).then(r => r.json());
let av, vo;
app.post('/api/video', auth, wrap(async (req, res) => {
  if (!av) av = E.HEYGEN_AVATAR_ID || (await HG('/v2/avatars')).data.avatars[0].avatar_id;
  if (!vo) { const v = (await HG('/v2/voices')).data.voices; vo = E.HEYGEN_VOICE_ID || (v.find(x => x.language === 'English') || v[0]).voice_id; }
  const r = await HG('/v2/video/generate', { method: 'POST', body: JSON.stringify({
    test: E.HEYGEN_TEST !== 'false', dimension: { width: 1280, height: 720 },
    video_inputs: [{ character: { type: 'avatar', avatar_id: av, avatar_style: 'normal' }, voice: { type: 'text', input_text: req.body.prompt.slice(0, 1500), voice_id: vo } }]
  }) });
  if (!r.data?.video_id) throw new Error(r.error?.message || r.message || 'HeyGen error');
  log(req.u, 'video', req.body.prompt, '[Video requested]');
  res.json({ id: r.data.video_id });
}));
app.get('/api/video/:id', auth, wrap(async (req, res) => {
  const r = await HG('/v1/video_status.get?video_id=' + encodeURIComponent(req.params.id)), d = r.data || {};
  res.json({ status: d.status, url: d.video_url, error: d.error?.message });
}));

// ---- history ----
app.get('/api/history', auth, (req, res) => {
  const l = db.chats.filter(c => c.uid === req.u.id && (!req.query.saved || c.saved)).slice(-40).reverse();
  res.json(l.map(({ id, mode, q, a, saved }) => ({ id, mode, q, a, saved })));
});
app.post('/api/save', auth, (req, res) => {
  const c = db.chats.find(c => c.id === req.body.id && c.uid === req.u.id);
  if (c) { c.saved = !c.saved; save(); }
  res.json({ saved: c?.saved });
});

// ---- admin ----
app.post('/api/admin/login', (req, res) => {
  if (!E.ADMIN_PASSWORD || req.body.password !== E.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  const t = rid(); admins.add(t); res.json({ token: t });
});
app.get('/api/admin/stats', adminOnly, (req, res) => {
  const now = Date.now();
  const active = Object.entries(live).filter(([, v]) => now - v.t < 45000).map(([id, v]) => ({ name: db.users[id]?.name, type: db.users[id]?.type, loc: db.users[id]?.loc, mode: v.mode || '-' }));
  res.json({ active, users: Object.keys(db.users).length, chats: db.chats.length, ann: db.ann, ad: db.ad });
});
app.get('/api/admin/chats', adminOnly, (req, res) => res.json(db.chats.slice(-200).reverse()));
app.post('/api/admin/announce', adminOnly, (req, res) => { db.ann = req.body.ann || ''; db.ad = req.body.ad || ''; save(); res.json({ ok: 1 }); });

app.listen(E.PORT || 3000, () => console.log('OMNIA AI running on http://localhost:' + (E.PORT || 3000)));
