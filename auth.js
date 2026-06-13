/**
 * Shared authentication module — per-user login with signed session tokens.
 * Used by acc_backend_server.js and idd_production_server.js.
 *
 * Users:   ./users.json (gitignored) — scrypt-hashed passwords, per-user role
 * Tokens:  HMAC-SHA256 signed, 8 hour expiry, sent as "Authorization: Bearer <token>"
 * Secret:  SESSION_SECRET env var, or auto-generated once into ./.session_secret
 *
 * First run: creates an "admin" user. Password comes from ADMIN_PASSWORD in .env,
 * or is randomly generated and printed to the console ONCE — save it.
 *
 * Manage users from the terminal:
 *   node auth.js add-user <username> <password> [admin|user]
 *   node auth.js remove-user <username>
 *   node auth.js list-users
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer as createHttpServer }  from 'http';
import { createServer as createHttpsServer } from 'https';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE   = path.join(__dirname, 'users.json');
const SECRET_FILE  = path.join(__dirname, '.session_secret');
const REVOKED_FILE = path.join(__dirname, '.revoked.json');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ─── Session secret ───────────────────────────────────────────────────────────
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ─── Token revocation (file-backed denylist of jti → expiry) ──────────────────
// Shared on disk so both servers honour the same revocations and they survive
// a restart. Re-read when the file changes; expired entries are pruned on write.
let _revokedCache = { mtime: 0, set: new Map() };
function loadRevoked() {
  try {
    const stat = fs.statSync(REVOKED_FILE);
    if (stat.mtimeMs !== _revokedCache.mtime) {
      const obj = JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'));
      _revokedCache = { mtime: stat.mtimeMs, set: new Map(Object.entries(obj)) };
    }
  } catch { /* no file yet → nothing revoked */ }
  return _revokedCache.set;
}
function isRevoked(jti) {
  return jti ? loadRevoked().has(jti) : false;
}
export function revokeToken(token) {
  const data = decodeToken(token);
  if (!data?.jti) return false;
  const map = new Map(loadRevoked());
  map.set(data.jti, data.exp);
  const now = Date.now();
  for (const [j, exp] of map) if (typeof exp === 'number' && exp < now) map.delete(j); // prune expired
  fs.writeFileSync(REVOKED_FILE, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  _revokedCache.mtime = 0; // force reload next check
  return true;
}

// ─── Password hashing (scrypt) ────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash     = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ─── User store ───────────────────────────────────────────────────────────────
function readUsers() {
  if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  // Bootstrap: create the admin account on first run
  const generated = !process.env.ADMIN_PASSWORD;
  const password  = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const users     = { admin: { passwordHash: hashPassword(password), role: 'admin' } };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
  if (generated) {
    console.log('\n  ╔════════════════════════════════════════════════════════╗');
    console.log('  ║  First run — admin account created                     ║');
    console.log(`  ║  Username: admin   Password: ${password.padEnd(25)} ║`);
    console.log('  ║  SAVE THIS PASSWORD — it will not be shown again.      ║');
    console.log('  ║  (Or set ADMIN_PASSWORD in .env before first run.)     ║');
    console.log('  ╚════════════════════════════════════════════════════════╝\n');
  }
  return users;
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

// ─── Session tokens (HMAC-SHA256, compact JWT-style) ─────────────────────────
export function signToken(username, role) {
  const payload = Buffer.from(JSON.stringify({
    sub: username, role, exp: Date.now() + TOKEN_TTL_MS,
    jti: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Validate signature + expiry only, returning the raw payload (incl. jti).
function decodeToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

export function verifyToken(token) {
  const data = decodeToken(token);
  if (!data || isRevoked(data.jti)) return null;
  return { username: data.sub, role: data.role || 'user' };
}

// ─── Express middleware ───────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const h    = req.headers.authorization || '';
  const user = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized — login required' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ ok: false, error: 'Forbidden — admin role required' });
    next();
  });
}

// POST /api/login  { username, password } → { ok, token, user }
export function loginHandler(req, res) {
  const { username, password } = req.body || {};
  const users = readUsers();
  const u = typeof username === 'string' ? users[username] : null;
  // Always run a verify so response timing doesn't reveal whether the user exists
  const dummy = 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128);
  const ok = verifyPassword(typeof password === 'string' ? password : '', u ? u.passwordHash : dummy) && !!u;
  if (!ok) return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  const role = u.role || 'user';
  res.json({ ok: true, token: signToken(username, role), user: { username, role } });
}

// POST /api/logout — revoke the caller's current token (requires auth).
export function logoutHandler(req, res) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) revokeToken(h.slice(7));
  res.json({ ok: true });
}

// ─── HTTP/HTTPS server factory ────────────────────────────────────────────────
// Set TLS_KEY_FILE + TLS_CERT_FILE in .env to serve HTTPS directly.
// Otherwise serve HTTP and terminate TLS at a reverse proxy (nginx/Caddy).
export function makeServer(app) {
  const key = process.env.TLS_KEY_FILE, cert = process.env.TLS_CERT_FILE;
  if (key && cert) {
    return { server: createHttpsServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, app), tls: true };
  }
  return { server: createHttpServer(app), tls: false };
}

// ─── CLI: node auth.js add-user|remove-user|list-users ───────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , cmd, name, pw, role] = process.argv;
  const users = readUsers();
  if (cmd === 'add-user' && name && pw) {
    users[name] = { passwordHash: hashPassword(pw), role: role === 'admin' ? 'admin' : 'user' };
    writeUsers(users);
    console.log(`User '${name}' saved (role: ${users[name].role}).`);
  } else if (cmd === 'remove-user' && name) {
    if (!users[name]) { console.log(`No such user '${name}'.`); process.exit(1); }
    delete users[name];
    writeUsers(users);
    console.log(`User '${name}' removed.`);
  } else if (cmd === 'list-users') {
    Object.entries(users).forEach(([n, u]) => console.log(`${n}  (${u.role || 'user'})`));
  } else {
    console.log('Usage:\n  node auth.js add-user <username> <password> [admin|user]\n  node auth.js remove-user <username>\n  node auth.js list-users');
  }
}
