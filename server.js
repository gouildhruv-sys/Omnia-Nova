require('dotenv').config();
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, DBF = 'db.json', day = () => new Date().toISOString().slice(0, 10), T0 = Date.now();
let db = { users: {}, chats: [], set: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DBF)) }; } catch {}
db.set = { ann: db.ann || '', ad: db.ad || '', adLink: '', adOn: !!db.ad, maint: false, off: {}, popup: '', popupId: 0, daily: 100, ...db.set };
const save = () => fs.writeFile(DBF, JSON.stringify(db), () => {});
const rid = () => crypto.randomBytes(16).toString('hex');
const sess = {}, admins = new Set(), live = {}, geo = {}, rate = {};
const dev = u => /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Other';
const nice = m => /quota|exceeded|rate.?limit/i.test(m) ? 'Free limit reached for now. Try again in a minute.' : String(m).split('\n')[0].slice(0, 200);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

async function where(ip) {
  ip = (ip || '').replace('::ffff:', '');
  if (geo[ip]) return geo[ip];
  try {
    const r = await (await fetch(`http://ip-api.com/json/${ip}?fields=city,country`, { signal: AbortSignal.timeout(4000) })).json();
    return (geo[ip] = r.country ? `${r.city}, ${r.country}` : 'Local, Unknown');
  } catch { return 'Unknown'; }
}
async function newUser(name, type, key, req) {
  const u = db.users[key] || (db.users[key] = { id: key, name, type, joined: Date.now() });
  if (u.banned) throw new Error('Your account has been blocked by admin.');
  u.loc = await where(req.ip); u.last = Date.now(); save();
  const t = rid(); sess[t] = u.id;
  return { token: t, user: { id: u.id, name: u.name, type: u.type } };
}
const auth = (req, res, next) => {
  const u = db.users[sess[(req.headers.authorization || '').slice(7)]];
  if (!u) return res.status(401).json({ error: 'Please sign in again' });
  if (u.banned) return res.status(403).json({ error: 'Your account has been blocked by admin.' });
  if (db.set.maint) return res.status(503).json({ error: 'OMNIA is under maintenance. Please come back soon.' });
  const now = Date.now(), r = rate[u.id] = (rate[u.id] || []).filter(t => now - t < 60000);
  if (req.method === 'POST' && req.path !== '/api/ping') { if (r.length >= 20) return res.status(429).json({ error: 'Too many requests. Wait a minute.' }); r.push(now); }
  u.last = now; live[u.id] = { ...live[u.id], t: now, dev: dev(req.headers['user-agent'] || '') };
  req.u = u; next();
};
const adminOnly = (req, res, next) => admins.has(req.headers['x-admin']) ? next() : res.status(403).json({ error: 'Admin only' });
const wrap = f => (req, res) => f(req, res).catch(e => res.status(e.code || 500).json({ error: nice(e.message) }));
const fail = (m, code) => Object.assign(new Error(m), { code });
const quota = u => { if (u.dd !== day()) { u.dd = day(); u.dn = 0; } if (u.dn >= db.set.daily) throw fail('Daily limit reached. Come back tomorrow!', 429); u.dn++; };

app.get('/api/config', (_, res) => { const s = db.set; res.json({ ann: s.ann, ad: s.ad, adLink: s.adLink, adOn: s.adOn, maint: s.maint, off: s.off, popup: s.popup, popupId: s.popupId, gid: E.GOOGLE_CLIENT_ID || '', discord: E.DISCORD_URL || 'https://discord.com' }); });
app.post('/api/guest', wrap(async (req, res) => { const id = 'guest-' + rid().slice(0, 6); res.json(await newUser('Guest ' + id.slice(6), 'guest', id, req)); }));
app.post('/api/google', wrap(async (req, res) => {
  const j = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential))).json();
  if (!j.sub || j.aud !== E.GOOGLE_CLIENT_ID) throw new Error('Google sign-in failed');
  res.json(await newUser(j.name || j.email, 'google', 'g' + j.sub, req));
}));
app.get('/api/me', auth, (req, res) => res.json({ name: req.u.name, type: req.u.type }));
app.post('/api/ping', auth, (req, res) => { live[req.u.id].mode = req.body.mode; res.json({ ok: 1 }); });

// ---- AI: chat+image -> Gemini, code -> Groq (auto model fallback), video -> HeyGen ----
const SYS = 'You are an expert programmer. Give working, clean code in fenced code blocks with a short explanation.';
const toG = m => m.map(x => ({ role: x.role === 'user' ? 'user' : 'model', parts: [{ text: x.content }] }));
async function gemini(model, body) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': E.GEMINI_API_KEY }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Gemini error');
  return j;
}
const gtext = j => (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || (() => { throw new Error('Empty reply. Try rephrasing.'); })();
const chatModel = E.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
let gm;
async function code(messages) {
  const list = [gm, E.GROQ_MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'].filter((x, i, a) => x && a.indexOf(x) === i);
  if (E.GROQ_API_KEY) for (const model of list) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.GROQ_API_KEY }, body: JSON.stringify({ model, messages: [{ role: 'system', content: SYS }, ...messages] }) });
    const j = await r.json();
    if (r.ok) { gm = model; return j.choices[0].message.content; }
    if (!/exist|access|decommission|not found|model/i.test(j.error?.message || '')) break;
  }
  return gtext(await gemini(chatModel, { systemInstruction: { parts: [{ text: SYS }] }, contents: toG(messages) })); // fallback so Code never dies
}
let gBad = 0;
async function image(q) {
  if (Date.now() > gBad && E.GEMINI_API_KEY) try {
    const j = await gemini(E.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image', { contents: [{ parts: [{ text: q }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
    const d = (j.candidates?.[0]?.content?.parts || []).find(x => x.inlineData || x.inline_data), i = d && (d.inlineData || d.inline_data);
    if (i) return `data:${i.mimeType || i.mime_type};base64,${i.data}`;
  } catch { gBad = Date.now() + 600000; } // free tier has no quota -> use free fallback for 10 min
  const r = await fetch('https://image.pollinations.ai/prompt/' + encodeURIComponent(q) + '?width=768&height=768&nologo=true&seed=' + (Date.now() % 1e6), { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Image service is busy. Try again in a minute.');
  return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,` + Buffer.from(await r.arrayBuffer()).toString('base64');
}
const log = (u, mode, q, a) => { const c = { id: rid(), uid: u.id, name: u.name, loc: u.loc, mode, q, a, t: Date.now(), saved: false }; db.chats.push(c); if (db.chats.length > 5000) db.chats.shift(); save(); live[u.id].mode = mode; return c; };
const gate = (u, mode) => { if (db.set.off[mode]) throw fail('This section is turned off right now.', 403); quota(u); };

app.post('/api/gen', auth, wrap(async (req, res) => {
  const { mode, messages } = req.body, last = messages[messages.length - 1].content;
  gate(req.u, mode);
  let a, img;
  if (mode === 'code') a = await code(messages);
  else if (mode === 'image') { img = await image(last); a = '[Image generated]'; }
  else a = gtext(await gemini(chatModel, { contents: toG(messages) }));
  log(req.u, mode, last, a);
  res.json({ text: img ? '' : a, img });
}));

const HG = (p, o = {}) => fetch('https://api.heygen.com' + p, { ...o, headers: { 'X-Api-Key': E.HEYGEN_API_KEY, 'Content-Type': 'application/json' } }).then(r => r.json());
let av, vo;
app.post('/api/video', auth, wrap(async (req, res) => {
  gate(req.u, 'video');
  if (!av) av = E.HEYGEN_AVATAR_ID || (await HG('/v2/avatars')).data.avatars[0].avatar_id;
  if (!vo) { const v = (await HG('/v2/voices')).data.voices; vo = E.HEYGEN_VOICE_ID || (v.find(x => x.language === 'English') || v[0]).voice_id; }
  const r = await HG('/v2/video/generate', { method: 'POST', body: JSON.stringify({ test: E.HEYGEN_TEST !== 'false', dimension: { width: 1280, height: 720 }, video_inputs: [{ character: { type: 'avatar', avatar_id: av, avatar_style: 'normal' }, voice: { type: 'text', input_text: req.body.prompt.slice(0, 1500), voice_id: vo } }] }) });
  if (!r.data?.video_id) throw new Error(r.error?.message || r.message || 'HeyGen error');
  log(req.u, 'video', req.body.prompt, '[Video requested]');
  res.json({ id: r.data.video_id });
}));
app.get('/api/video/:id', auth, wrap(async (req, res) => {
  const d = (await HG('/v1/video_status.get?video_id=' + encodeURIComponent(req.params.id))).data || {};
  res.json({ status: d.status, url: d.video_url, error: d.error?.message });
}));

app.get('/api/history', auth, (req, res) => {
  const l = db.chats.filter(c => c.uid === req.u.id && (!req.query.saved || c.saved)).slice(-40).reverse();
  res.json(l.map(({ id, mode, q, a, saved }) => ({ id, mode, q, a, saved })));
});
app.post('/api/save', auth, (req, res) => { const c = db.chats.find(c => c.id === req.body.id && c.uid === req.u.id); if (c) { c.saved = !c.saved; save(); } res.json({ saved: c?.saved }); });

// ---- admin ----
app.post('/api/admin/login', (req, res) => {
  if (!E.ADMIN_PASSWORD || req.body.password !== E.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  const t = rid(); admins.add(t); res.json({ token: t });
});
app.get('/api/admin/stats', adminOnly, (req, res) => {
  const now = Date.now(), d0 = new Date().setHours(0, 0, 0, 0), by = {}, days = Array(7).fill(0), ctry = {};
  const active = Object.entries(live).filter(([, v]) => now - v.t < 45000).map(([id, v]) => ({ id, name: db.users[id]?.name, type: db.users[id]?.type, loc: db.users[id]?.loc, dev: v.dev, mode: v.mode || '-' }));
  db.chats.forEach(c => { by[c.mode] = (by[c.mode] || 0) + 1; const i = 6 - Math.floor((d0 - new Date(c.t).setHours(0, 0, 0, 0)) / 864e5); if (i >= 0 && i < 7) days[i]++; });
  Object.values(db.users).forEach(u => { const c = (u.loc || 'Unknown').split(', ').pop(); ctry[c] = (ctry[c] || 0) + 1; });
  res.json({ active, users: Object.keys(db.users).length, chats: db.chats.length, by, days, ctry, set: db.set,
    server: { up: process.uptime(), mem: Math.round(process.memoryUsage().rss / 1048576), keys: { Gemini: !!E.GEMINI_API_KEY, Groq: !!E.GROQ_API_KEY, HeyGen: !!E.HEYGEN_API_KEY, 'Google login': !!E.GOOGLE_CLIENT_ID } } });
});
app.get('/api/admin/users', adminOnly, (req, res) => {
  const n = {}; db.chats.forEach(c => n[c.uid] = (n[c.uid] || 0) + 1);
  res.json(Object.values(db.users).sort((a, b) => b.last - a.last).map(u => ({ id: u.id, name: u.name, type: u.type, loc: u.loc, joined: u.joined, last: u.last, banned: !!u.banned, n: n[u.id] || 0 })));
});
app.get('/api/admin/chats', adminOnly, (req, res) => {
  const { q, mode, uid, all } = req.query, s = (q || '').toLowerCase();
  let l = db.chats.filter(c => (!mode || c.mode === mode) && (!uid || c.uid === uid) && (!s || (c.q + ' ' + c.a).toLowerCase().includes(s)));
  res.json(all ? l : l.slice(-300).reverse());
});
app.post('/api/admin/chat/delete', adminOnly, (req, res) => { db.chats = db.chats.filter(c => c.id !== req.body.id); save(); res.json({ ok: 1 }); });
app.post('/api/admin/user', adminOnly, (req, res) => {
  const { id, act } = req.body, u = db.users[id]; if (!u) return res.status(404).json({ error: 'No such user' });
  if (act === 'ban') u.banned = true; else if (act === 'unban') u.banned = false;
  else if (act === 'clear') db.chats = db.chats.filter(c => c.uid !== id);
  else if (act === 'delete') { db.chats = db.chats.filter(c => c.uid !== id); delete db.users[id]; }
  save(); res.json({ ok: 1 });
});
app.post('/api/admin/set', adminOnly, (req, res) => {
  const b = req.body, s = db.set;
  for (const k of ['ann', 'ad', 'adLink', 'adOn', 'maint', 'off', 'daily']) if (b[k] !== undefined) s[k] = b[k];
  if ((b.popup !== undefined && b.popup !== s.popup) || b.resend) s.popupId++;
  if (b.popup !== undefined) s.popup = b.popup;
  save(); res.json({ ok: 1 });
});

app.listen(E.PORT || 3000, () => console.log('OMNIA AI running on http://localhost:' + (E.PORT || 3000)));
