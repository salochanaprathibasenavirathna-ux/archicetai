const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env'), override: true });
if (process.env.PORTABLE_EXECUTABLE_DIR) dotenv.config({ path: path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.env'), override: true });
dotenv.config({ path: path.join(path.dirname(process.execPath), '.env') });

const express = require('express');

/* ---------- prompts ---------- */
const SYSTEM = `You are ArchitectAI, a senior software architect. The user describes an app or website idea, or attaches a requirements/system document (or a wireframe image).
Reply with ONLY valid JSON (no markdown fences) in this exact shape:
{
  "summary": "1-2 sentence overview",
  "steps": [{"title": "short title", "detail": "what happens in this step"}],
  "mermaid": "a valid Mermaid flowchart starting with 'flowchart TD'",
  "code_guidance": {
    "frontend": [{"file": "path/name", "purpose": "what it does"}],
    "backend": [{"file": "path/name", "purpose": "what it does"}],
    "tech_stack": ["..."],
    "snippet": "one short, useful starter code example"
  },
  "security": [{"risk": "e.g. SQL Injection", "where": "where it can occur in this app", "fix": "how to prevent it"}]
}
Rules:
- If a document is attached, read it carefully first. Base the flow, files and security risks on the features, roles, data and rules described in that document, not on generic guesses.
- Mermaid: put EVERY node label in double quotes, e.g. A["Login page"]. No special characters outside quotes. Use only flowchart TD.
- Write steps, purposes, risks and fixes in the same language the user wrote in (Sinhala or English). Keep file names and code in English.
- Give 5-12 steps, and at least 4 relevant security risks (auth, injection, XSS, data exposure, rate limiting, etc).
- If the user asks a follow-up, update the previous design accordingly and return the full JSON again.`;

const MEMORY_RULES = `

MEMORY: You also receive a list of this user's PREVIOUS PROJECTS (from their earlier chats).
- If the user only asks about a previous project, or a general question, reply with JSON:
  {"chat_reply": "your answer in the user's language", "open_chat_id": "id of the project, only if relevant"}
  and omit the design fields.
- If the user asks for a new or updated design, return the full design JSON as before.
  You may also add a short "chat_reply".
- Use ONLY the projects listed. If nothing matches, say you don't have it.`;

const PLAN_SYSTEM = `You are a senior software architect planning the file list of a project. You get an app design and generation options. List every file needed for a COMPLETE, WORKING project.
Rules:
- Output JSON: {"files":[{"path":"...","purpose":"one line: what the file contains and which other files it imports or calls"}],"run_instructions":"..."}.
- At most 18 files. Always include the dependency manifest of the chosen stack (package.json / requirements.txt / pom.xml / go.mod / *.csproj / composer.json), an env/config example file and README.md.
- Respect the options exactly (scope and languages). Keep it small but complete.
- File paths in English. run_instructions: short, step by step, in the same language the user wrote in (Sinhala or English).`;

const FILE_SYSTEM = `You are a senior full-stack engineer writing ONE file of a larger project. Output ONLY the raw content of that file: no markdown fences, no text before or after it.
Rules:
- Write the COMPLETE, working file. No placeholders, no "...", no TODO stubs.
- Import and call other files using exactly the paths and names in the project file list, so all files fit together.
- Implement the security fixes from the design that apply to this file (password hashing, input validation, rate limiting, parameterized queries, secure tokens/cookies, XSS/CSRF protection, etc.).
- Code comments and README text in the same language the user wrote in (Sinhala or English). Identifiers and file names in English.`;

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    files: { type: 'ARRAY', items: { type: 'OBJECT', properties: { path: { type: 'STRING' }, purpose: { type: 'STRING' } }, required: ['path', 'purpose'] } },
    run_instructions: { type: 'STRING' }
  },
  required: ['files']
};

/* ---------- code generation options (allow-lists, so user input never goes into prompts raw) ---------- */
const BACKENDS = {
  auto: "Follow the design's tech stack (default: Node.js + Express)", node: 'Node.js + Express',
  'python-flask': 'Python + Flask', 'python-fastapi': 'Python + FastAPI', 'python-django': 'Python + Django',
  php: 'PHP 8 (plain PHP + PDO)', laravel: 'PHP + Laravel', java: 'Java + Spring Boot (Maven)',
  csharp: 'C# + ASP.NET Core Web API', go: 'Go (net/http)'
};
const FRONTENDS = {
  auto: "Follow the design's tech stack (default: plain HTML + CSS + JS)", html: 'Plain HTML + CSS + JavaScript (no build step)',
  react: 'React + Vite', vue: 'Vue 3 + Vite', svelte: 'Svelte + Vite', nextjs: 'Next.js (App Router)', angular: 'Angular'
};
const SCOPE_RULES = {
  both: 'Generate BOTH backend and frontend. Put server code under backend/ and UI code under frontend/ (a single project is fine only if the chosen stack is full-stack, e.g. Next.js, Laravel or Django).',
  backend: 'Generate ONLY the backend / API (no UI files at all). Include API.md that lists every endpoint with request and response examples.',
  frontend: 'Generate ONLY the frontend / UI (no server code). The UI must call the backend through a configurable API base URL (config/env file). The README must list the API endpoints the UI expects, and the UI should include a small mock-data fallback so it runs without a backend.'
};
function normOptions(o) {
  o = o && typeof o === 'object' ? o : {};
  return {
    scope: SCOPE_RULES[o.scope] ? o.scope : 'both',
    backend: BACKENDS[o.backend] ? o.backend : 'auto',
    frontend: FRONTENDS[o.frontend] ? o.frontend : 'auto'
  };
}
function describeOptions(o) {
  const lines = [`Scope: ${o.scope}. ${SCOPE_RULES[o.scope]}`];
  if (o.scope !== 'frontend') lines.push(`Backend language/framework: ${BACKENDS[o.backend]}`);
  if (o.scope !== 'backend') lines.push(`Frontend language/framework: ${FRONTENDS[o.frontend]}`);
  return lines.join('\n');
}
const slimDesign = r => { const { mermaid, chat_reply, open_chat_id, ...rest } = r || {}; return rest; };

/* ---------- Gemini helpers ---------- */
const getModel = () => (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const keyHint = k => (k ? `${k.slice(0, 4)}…${k.slice(-4)}, දිග ${k.length}` : '');
// Only the key the user typed in the app (UI) is used. The key in .env is ignored on purpose.
const keyFor = sess => (sess && sess.apiKey) || '';
const NO_KEY = 'ඔයාගේ Gemini API key එක තවම දාලා නැහැ. උඩ "● API" බොත්තම click කරලා, නැත්නම් ☰ menu එකේ 🔑 API key එකෙන් දාන්න (නොමිලේ ගන්න: aistudio.google.com/apikey).';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gemini(body, key, timeoutMs = 120000) {
  let last = { error: 'Gemini error', status: 500 };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep((last.status === 429 ? [0, 5000, 15000, 30000] : [0, 1500, 4000, 9000])[attempt]);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
        return { text, finish: cand?.finishReason };
      }
      const msg = data.error?.message || 'Gemini error';
      const hint = /API key/i.test(msg) ? ` [පාවිච්චි වුණු key: ${keyHint(key)}]` : '';
      last = { error: msg + hint, status: r.status };
      if (![429, 500, 502, 503, 504].includes(r.status)) return last;
    } catch (e) {
      last = { error: 'Gemini එකට සම්බන්ධ වෙන්න බැහැ (internet බලන්න): ' + e.message, status: 502 };
    }
  }
  return last;
}
// Code calls: switch "thinking" off on flash models (thinking tokens eat the output budget and cut the code off)
async function geminiCode(body, key) {
  if (/flash/i.test(getModel())) {
    const b = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingBudget: 0 } } };
    const out = await gemini(b, key);
    if (!(out.status === 400 && /thinking/i.test(out.error || ''))) return out;
  }
  return gemini(body, key);
}

/* ---------- local storage: accounts + per-user chat history ---------- */
function dataDir() {
  const dir = process.env.ARCHITECTAI_DATA || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const writeJson = (f, obj) => { fs.writeFileSync(f + '.tmp', JSON.stringify(obj)); fs.renameSync(f + '.tmp', f); };
function loadUsers() {
  try { const u = JSON.parse(fs.readFileSync(path.join(dataDir(), 'users.json'), 'utf8')); return Array.isArray(u.users) ? u : { users: [] }; }
  catch { return { users: [] }; }
}
const saveUsers = u => writeJson(path.join(dataDir(), 'users.json'), u);
const chatsFile = uid => path.join(dataDir(), `chats-${uid}.json`);
// Chat files are encrypted with a key that only exists while that user is logged in (derived from their password)
function load(uid, key) {
  let o; try { o = JSON.parse(fs.readFileSync(chatsFile(uid), 'utf8')); } catch { return {}; }
  if (o && o.iv && o.tag && o.data) { const t = decrypt(o, key); if (!t) throw new Error('Chat file could not be decrypted'); return JSON.parse(t); }
  return o;                                       // old plain-text file: it is encrypted on the next save
}
function save(uid, db, key) { writeJson(chatsFile(uid), encrypt(JSON.stringify(db), key)); }
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => res.status(500).json({ error: 'Server error: ' + e.message }));

/* ---------- accounts, password hashing, sessions ---------- */
const scrypt = (pin, salt) => new Promise((res, rej) => crypto.scrypt(String(pin), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function derive(pin, saltHex) {            // 64 bytes: first half = login check, second half = encrypts the user's API key
  const k = await scrypt(pin, Buffer.from(saltHex, 'hex'));
  return { verifier: k.subarray(0, 32), encKey: k.subarray(32) };
}
function encrypt(text, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function decrypt(o, key) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'hex'));
    d.setAuthTag(Buffer.from(o.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(o.data, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}
const sessions = new Map();                       // token -> { uid, name, owner, apiKey, encKey, last }
const SESSION_TTL = 12 * 60 * 60 * 1000;
const loginFails = new Map();                     // name -> { n, until }
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function startSession(res, user, encKey) {
  const token = crypto.randomBytes(32).toString('hex');
  const apiKey = user.apiKey ? decrypt(user.apiKey, encKey) : '';
  sessions.set(token, { uid: user.id, name: user.name, owner: !!user.owner, apiKey, encKey, last: Date.now() });
  res.setHeader('Set-Cookie', `aai_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
}
const cleanName = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 30);
const validPassword = p => typeof p === 'string' && p.length >= 12 && p.length <= 128;

const MEDIA = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const TEXT_EXT = ['.txt', '.md', '.json', '.csv', '.html', '.js', '.py', '.sql', '.yaml', '.yml', '.xml', '.php', '.java'];

function buildMemory(db, currentId) {
  const items = Object.values(db)
    .filter(c => c.id !== currentId && c.result)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 15)
    .map(c => {
      const r = c.result, g = r.code_guidance || {};
      return `- id:${c.id} | "${c.title}" | ${new Date(c.updated).toISOString().slice(0, 10)}
  summary: ${r.summary || ''}
  stack: ${(g.tech_stack || []).join(', ')}
  steps: ${(r.steps || []).map(s => s.title).join(' > ')}
  security: ${(r.security || []).map(s => s.risk).join(', ')}`;
    });
  return items.length ? `\n\nPREVIOUS PROJECTS (newest first):\n${items.join('\n')}` : '';
}

const cleanPath = p => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '')
  .split('/').filter(x => x && x !== '.' && x !== '..').join('/');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '30mb' }));

  /* ----- basic hardening: host check, cross-site check, headers, session lookup ----- */
  app.use((req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return res.status(403).end('Forbidden');
    if (req.method !== 'GET' && req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).end('Forbidden'); } catch { return res.status(403).end('Forbidden'); }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    const token = getCookie(req, 'aai_session'), s = sessions.get(token);
    if (s && Date.now() - s.last < SESSION_TTL) { s.last = Date.now(); req.sess = s; req.token = token; }
    else if (s) sessions.delete(token);
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  const requireAuth = (req, res, next) => (req.sess ? next() : res.status(401).json({ error: 'ඇතුල් වෙන්න (login).', code: 'AUTH' }));
  const needKey = (req, res) => {
    const key = keyFor(req.sess);
    if (!key) { res.status(400).json({ error: NO_KEY, code: 'NO_KEY' }); return null; }
    return key;
  };

  /* ----- accounts ----- */
  app.get('/api/auth/status', (req, res) => {
    const s = req.sess;
    res.json({
      loggedIn: !!s, name: s ? s.name : null, hasAccounts: loadUsers().users.length > 0,
      hasKey: !!(s && s.apiKey)
    });
  });
  app.post('/api/auth/register', safe(async (req, res) => {
    if (req.token) sessions.delete(req.token);
    const name = cleanName(req.body.name), pin = req.body.pin;
    if (!name) return res.status(400).json({ error: 'නමක් ඇතුළත් කරන්න.' });
    if (!validPassword(pin)) return res.status(400).json({ error: 'Password එක අකුරු 12ත් 128ත් අතර විය යුතුයි.' });
    const u = loadUsers();
    if (u.users.some(x => x.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'මේ නමින් ගිණුමක් දැනටමත් තියෙනවා.' });
    const salt = crypto.randomBytes(16).toString('hex'), { verifier, encKey } = await derive(pin, salt);
    const user = { id: crypto.randomBytes(8).toString('hex'), name, salt, verifier: verifier.toString('hex'), owner: u.users.length === 0, created: Date.now() };
    if (user.owner) { // first account takes over the old single-user history, if any
      const legacy = path.join(dataDir(), 'chats.json');
      if (fs.existsSync(legacy)) { try { save(user.id, JSON.parse(fs.readFileSync(legacy, 'utf8')), encKey); fs.unlinkSync(legacy); } catch {} }
    }
    u.users.push(user); saveUsers(u);
    startSession(res, user, encKey);
    res.json({ ok: true, name });
  }));
  app.post('/api/auth/login', safe(async (req, res) => {
    if (req.token) sessions.delete(req.token);
    const name = cleanName(req.body.name), pin = String(req.body.pin || ''), f = loginFails.get(name.toLowerCase()) || { n: 0, until: 0 };
    if (Date.now() < f.until) return res.status(429).json({ error: 'වැරදි උත්සාහ වැඩියි. තත්පර 30කින් නැවත උත්සාහ කරන්න.' });
    const user = loadUsers().users.find(x => x.name.toLowerCase() === name.toLowerCase());
    const { verifier, encKey } = await derive(pin, user ? user.salt : '00'.repeat(16));   // same work for unknown names
    const ok = user && crypto.timingSafeEqual(verifier, Buffer.from(user.verifier, 'hex'));
    if (!ok) {
      f.n += 1; if (f.n >= 5) { f.until = Date.now() + 30000; f.n = 0; }
      loginFails.set(name.toLowerCase(), f);
      return res.status(400).json({ error: 'නම හෝ password එක වැරදියි.' });
    }
    loginFails.delete(name.toLowerCase());
    startSession(res, user, encKey);
    res.json({ ok: true, name: user.name });
  }));
  app.post('/api/auth/logout', (req, res) => {
    if (req.token) sessions.delete(req.token);
    res.setHeader('Set-Cookie', 'aai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  app.post('/api/auth/apikey', requireAuth, (req, res) => {
    const k = String(req.body.apiKey || '').trim().replace(/^["']|["']$/g, '');
    if (k && (k.length < 20 || k.length > 200 || /\s/.test(k))) return res.status(400).json({ error: 'API key එක හරි ෆෝමැට් එකේ නැහැ. නැවත copy කරන්න.' });
    const u = loadUsers(), user = u.users.find(x => x.id === req.sess.uid);
    if (!user) return res.status(404).json({ error: 'ගිණුම හොයාගන්න බැහැ.' });
    if (k) user.apiKey = encrypt(k, req.sess.encKey); else delete user.apiKey;
    saveUsers(u); req.sess.apiKey = k;
    res.json({ ok: true, hasKey: !!k });
  });

  app.post('/api/auth/password', requireAuth, safe(async (req, res) => {
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) {
      return res.status(400).json({ error: 'දැනට භාවිතා කරන password එක ඇතුළත් කරන්න.' });
    }
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'අලුත් password එක අකුරු 12ත් 128ත් අතර විය යුතුයි.' });

    const users = loadUsers(), user = users.users.find(x => x.id === req.sess.uid);
    if (!user) return res.status(404).json({ error: 'ගිණුම හොයාගන්න බැහැ.' });
    const current = await derive(currentPassword, user.salt);
    if (!crypto.timingSafeEqual(current.verifier, Buffer.from(user.verifier, 'hex'))) {
      return res.status(400).json({ error: 'දැනට භාවිතා කරන password එක වැරදියි.' });
    }
    if (user.apiKey && !req.sess.apiKey) {
      return res.status(400).json({ error: 'Saved API key එක decrypt කරන්න බැහැ. Password එක වෙනස් කළේ නැහැ.' });
    }

    const db = load(user.id, current.encKey);
    const salt = crypto.randomBytes(16).toString('hex');
    const next = await derive(newPassword, salt);
    const previousSalt = user.salt, previousVerifier = user.verifier, previousApiKey = user.apiKey;

    save(user.id, db, next.encKey);
    user.salt = salt;
    user.verifier = next.verifier.toString('hex');
    if (req.sess.apiKey) user.apiKey = encrypt(req.sess.apiKey, next.encKey);
    try {
      saveUsers(users);
    } catch (error) {
      user.salt = previousSalt;
      user.verifier = previousVerifier;
      user.apiKey = previousApiKey;
      save(user.id, db, current.encKey);
      throw error;
    }

    for (const [token, session] of sessions) {
      if (session.uid === user.id && token !== req.token) sessions.delete(token);
    }
    req.sess.encKey = next.encKey;
    res.json({ ok: true });
  }));

  /* ----- API key check (uses the logged-in user's own key) ----- */
  app.get('/api/health', requireAuth, async (req, res) => {
    const key = keyFor(req.sess);
    if (!key) return res.json({ ok: false, message: NO_KEY });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${getModel()}`, { headers: { 'x-goog-api-key': key } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return res.json({ ok: true, message: `API key හරි ✅ (${keyHint(key)}) • model: ${getModel()}` });
      res.json({ ok: false, message: `${d.error?.message || 'Error ' + r.status} [key: ${keyHint(key)}, model: ${getModel()}]` });
    } catch (e) {
      res.json({ ok: false, message: 'Gemini එකට සම්බන්ධ වෙන්න බැහැ (internet බලන්න): ' + e.message });
    }
  });

  /* ----- chat history (private to each account) ----- */
  app.get('/api/chats', requireAuth, (req, res) => {
    const list = Object.values(load(req.sess.uid, req.sess.encKey)).map(c => ({ id: c.id, title: c.title, updated: c.updated }))
      .sort((a, b) => b.updated - a.updated);
    res.json(list);
  });
  app.get('/api/chats/:id', requireAuth, (req, res) => {
    const c = load(req.sess.uid, req.sess.encKey)[req.params.id];
    c ? res.json(c) : res.status(404).json({ error: 'Chat එක හොයාගන්න බැහැ.' });
  });
  app.delete('/api/chats/:id', requireAuth, (req, res) => {
    const db = load(req.sess.uid, req.sess.encKey); delete db[req.params.id]; save(req.sess.uid, db, req.sess.encKey); res.json({ ok: true });
  });

  /* ----- design (flowchart + guidance + security) ----- */
  app.post('/api/generate', requireAuth, safe(async (req, res) => {
    const key = needKey(req, res); if (!key) return;
    const uid = req.sess.uid, { chatId, file } = req.body;
    let text = String(req.body.text || '').trim();
    if (!text && !file) return res.status(400).json({ error: 'Message එකක් හෝ ලේඛනයක් දාන්න.' });
    if (!text) text = 'මේ ලේඛනය අනුව flow එක, code guidance සහ security insights හදන්න.';

    const parts = [{ text }];
    if (file) {
      const ext = path.extname(file.name || '').toLowerCase();
      const buf = Buffer.from(String(file.data || ''), 'base64');
      if (MEDIA[ext]) {
        parts.push({ inlineData: { mimeType: MEDIA[ext], data: file.data } });
      } else if (ext === '.docx') {
        try {
          const mammoth = require('mammoth');
          const { value } = await mammoth.extractRawText({ buffer: buf });
          parts[0].text += `\n\n[Document: ${file.name}]\n${value.slice(0, 60000)}`;
        } catch (e) { return res.status(400).json({ error: 'DOCX ෆයිල් එක කියවන්න බැරි වුණා (npm install කළාද?).' }); }
      } else if (TEXT_EXT.includes(ext)) {
        parts[0].text += `\n\n[Document: ${file.name}]\n${buf.toString('utf8').slice(0, 60000)}`;
      } else {
        return res.status(400).json({ error: 'මේ ෆයිල් වර්ගය support නැහැ. PDF, DOCX, TXT, MD, PNG, JPG පාවිච්චි කරන්න.' });
      }
    }

    const db = load(uid, req.sess.encKey);
    const chat = (chatId && db[chatId]) || null;
    const history = (chat ? chat.messages : []).slice(-10).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.role === 'user' ? m.text + (m.doc ? `\n[Attached document: ${m.doc}]` : '') : m.text }]
    }));

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM + MEMORY_RULES + buildMemory(db, chat && chat.id) }] },
      contents: [...history, { role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 32000 }
    };

    const out = await gemini(body, key);
    if (out.error) return res.status(out.status || 500).json({ error: out.error });
    const raw = out.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    let result;
    try { result = JSON.parse(raw); }
    catch { return res.status(502).json({ error: out.finish === 'MAX_TOKENS' ? 'Design එක ගොඩක් දිගයි, අඩකින් කැඩුණා. Project එක පොඩි කරලා නැවත try කරන්න.' : 'AI එකෙන් ආපු JSON එක වැරදියි. නැවත try කරන්න.' }); }

    const c = chat || { id: crypto.randomUUID(), title: (file ? file.name : text).slice(0, 40), created: Date.now(), messages: [] };
    c.messages.push({ role: 'user', text, doc: file ? file.name : undefined });
    c.messages.push({ role: 'ai', text: raw });
    if (result.mermaid) { c.result = result; delete c.code; } // design changed -> old code is outdated
    c.updated = Date.now();
    db[c.id] = c; save(uid, db, req.sess.encKey);
    res.json({ chatId: c.id, title: c.title, result });
  }));

  /* ----- full project code: plan the files, then write them one by one (no more cut-off code) ----- */
  const jobs = new Map();
  const labels = o => Object.entries(o).map(([id, label]) => ({ id, label }));
  app.get('/api/codegen/options', requireAuth, (req, res) => res.json({ backends: labels(BACKENDS), frontends: labels(FRONTENDS) }));

  async function runCodegen(job, chat, options, key) {
    const lastUser = [...chat.messages].reverse().find(m => m.role === 'user');
    const ctx = `Design (JSON):\n${JSON.stringify(slimDesign(chat.result))}\n\nOptions:\n${describeOptions(options)}\n\nUser's latest request: ${lastUser ? lastUser.text : ''}`;

    const plan = await geminiCode({
      systemInstruction: { parts: [{ text: PLAN_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: ctx + '\n\nList the project files now.' }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA, temperature: 0.2, maxOutputTokens: 8000 }
    }, key);
    if (plan.error) throw new Error(plan.error);
    let parsed; try { parsed = JSON.parse(plan.text); } catch { throw new Error('File list එක හදන්න බැරි වුණා. නැවත try කරන්න.'); }
    const seen = new Set();
    const files = (parsed.files || []).slice(0, 18)
      .map(f => ({ path: cleanPath(f.path), purpose: String(f.purpose || '') }))
      .filter(f => f.path && !seen.has(f.path) && seen.add(f.path));
    if (!files.length) throw new Error('Code ෆයිල් කිසිවක් plan වුණේ නැහැ. නැවත try කරන්න.');
    job.total = files.length; job.state = 'writing';

    const listing = files.map(f => `- ${f.path}: ${f.purpose}`).join('\n');
    const warnings = [], results = new Array(files.length);
    async function writeFile(f) {
      let contents = [{ role: 'user', parts: [{ text: `${ctx}\n\nPROJECT FILE LIST:\n${listing}\n\nWrite this file now: ${f.path}\nPurpose: ${f.purpose}` }] }];
      let text = '', complete = false;
      for (let part = 0; part < 4; part++) {                    // if the answer is cut off, ask it to continue
        const r = await geminiCode({ systemInstruction: { parts: [{ text: FILE_SYSTEM }] }, contents, generationConfig: { temperature: 0.2, maxOutputTokens: 16384 } }, key);
        if (r.error) { if (!part) return { error: r.error }; break; }
        text += r.text;
        if (r.finish !== 'MAX_TOKENS') { complete = true; break; }
        contents = [...contents, { role: 'model', parts: [{ text: r.text }] },
          { role: 'user', parts: [{ text: 'Continue the file EXACTLY from where you stopped. Output only the remaining raw content: no code fences, do not repeat anything.' }] }];
      }
      text = text.replace(/^\s*```[\w+-]*\n/, '').replace(/\n```\s*$/, '');
      if (!complete) warnings.push(`${f.path} (කැඩිලා තියෙන්න පුළුවන්)`);
      else if (/\.json$/i.test(f.path)) { try { JSON.parse(text); } catch { warnings.push(`${f.path} (JSON වැරදියි)`); } }
      return { content: text };
    }
    let next = 0;
    async function worker() {
      while (next < files.length) {
        const i = next++, r = await writeFile(files[i]);
        if (r.error) { warnings.push(`${files[i].path} (${r.error.slice(0, 80)})`); results[i] = `// ⚠ Generation failed: ${r.error}\n`; }
        else results[i] = r.content;
        job.done++;
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
    if (warnings.length === files.length) throw new Error(`Code generate කරන්න බැරි වුණා: ${warnings[0]}`);

    const code = {
      files: files.map((f, i) => ({ path: f.path, content: results[i] })),
      notes: String(parsed.run_instructions || '') + (warnings.length ? `\n\n⚠ මේ ෆයිල් වල ගැටලුවක් තිබුණා (නැවත generate කරන්න): ${warnings.join(', ')}` : ''),
      created: Date.now(), options
    };
    const db = load(job.uid, job.encKey), c = db[chat.id];
    if (c) { c.code = code; c.updated = Date.now(); save(job.uid, db, job.encKey); }
    job.code = code; job.state = 'done'; delete job.encKey;
  }

  app.post('/api/codegen', requireAuth, (req, res) => {
    const key = needKey(req, res); if (!key) return;
    const uid = req.sess.uid, chat = load(uid, req.sess.encKey)[req.body.chatId];
    if (!chat || !chat.result) return res.status(400).json({ error: 'මුලින් design එකක් (flowchart) හදන්න.' });
    for (const [id, j] of jobs) if (Date.now() - j.created > 30 * 60 * 1000) jobs.delete(id);
    for (const j of jobs.values()) if (j.uid === uid && (j.state === 'planning' || j.state === 'writing')) return res.status(409).json({ error: 'Code generation එකක් දැනටමත් ක්‍රියාත්මක වෙනවා. ඉවර වෙනකම් ඉන්න.' });
    const job = { id: crypto.randomUUID(), uid, encKey: req.sess.encKey, state: 'planning', done: 0, total: 0, error: null, code: null, created: Date.now() };
    jobs.set(job.id, job);
    runCodegen(job, chat, normOptions(req.body.options), key).catch(e => { job.state = 'error'; job.error = e.message || 'Code generate කරන්න බැරි වුණා.'; delete job.encKey; });
    res.json({ jobId: job.id });
  });
  app.get('/api/codegen/:id', requireAuth, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.uid !== req.sess.uid) return res.status(404).json({ error: 'Job එක හොයාගන්න බැහැ (app එක restart වුණාද?). නැවත generate කරන්න.' });
    res.json({ state: j.state, done: j.done, total: j.total, error: j.error, code: j.state === 'done' ? j.code : undefined });
  });

  return app;
}

function startServer(port = process.env.PORT || 3000) {
  return new Promise((resolve, reject) => {
    const srv = createApp().listen(port, '127.0.0.1', () => resolve(srv.address().port));
    srv.on('error', reject);
  });
}

module.exports = { createApp, startServer };

if (require.main === module) {
  startServer().then(p => console.log(`ArchitectAI running: http://localhost:${p}`));
}