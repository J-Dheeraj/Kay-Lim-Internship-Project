/**
 * Shared authentication module — per-user login with signed session tokens.
 * Used by server.js (unified backend).
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
import Database from 'better-sqlite3';
import { createServer as createHttpServer }  from 'http';
import { createServer as createHttpsServer } from 'https';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
// Identity/session paths are env-overridable so both services can share one
// volume in a deployment (set the same DATA_DIR + SESSION_SECRET for both).
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const USERS_FILE   = process.env.USERS_FILE  || path.join(DATA_DIR, 'users.json');
const SECRET_FILE  = process.env.SECRET_FILE || path.join(DATA_DIR, '.session_secret');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ─── Token revocation store (SQLite) ─────────────────────────────────────────
// SQLite WAL mode allows concurrent readers + one writer without any file-level
// locking. revokeToken() and isRevoked() are individually atomic — no race
// window is possible (replaces the previous append-only NDJSON approach).
// Lazily opened on first use (not at module load) so merely importing auth.js
// — e.g. a script that only needs hashPassword() — doesn't have the side
// effect of creating a revocations.db file on disk.
let _revokedDb, _revokeStmt, _isRevokedSt, _purgeStmt;
function revokedDb() {
  if (!_revokedDb) {
    _revokedDb = new Database(path.join(DATA_DIR, 'revocations.db'));
    _revokedDb.pragma('journal_mode = WAL');
    _revokedDb.exec(`
      CREATE TABLE IF NOT EXISTS revocations (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_rev_exp ON revocations(exp);
    `);
    _revokeStmt  = _revokedDb.prepare('INSERT OR REPLACE INTO revocations (jti, exp) VALUES (?,?)');
    _isRevokedSt = _revokedDb.prepare('SELECT 1 FROM revocations WHERE jti=?');
    _purgeStmt   = _revokedDb.prepare('DELETE FROM revocations WHERE exp < ?');
  }
  return _revokedDb;
}

export function purgeExpiredRevocations() {
  revokedDb();
  const { changes } = _purgeStmt.run(Date.now());
  return changes;
}

export function closeRevokedDb() {
  if (_revokedDb) { _revokedDb.close(); _revokedDb = null; }
}

// ─── Session secret ───────────────────────────────────────────────────────────
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ─── Config safety: refuse to start with example/placeholder secrets ──────────
const PLACEHOLDER_SECRETS = new Set([
  'replace_with_a_long_random_hex_string', 'choose_a_strong_admin_password',
  'changeme-admin', 'changeme', 'change_me', 'password', 'admin',
]);
export function assertSecureConfig() {
  const bad = [];
  const ss = process.env.SESSION_SECRET, ap = process.env.ADMIN_PASSWORD;
  if (ss && PLACEHOLDER_SECRETS.has(ss))               bad.push('SESSION_SECRET is the example placeholder');
  if (ss && ss.length < 32)                            bad.push('SESSION_SECRET is shorter than 32 chars');
  if (ap && PLACEHOLDER_SECRETS.has(ap))               bad.push('ADMIN_PASSWORD is the example placeholder');
  if (ap && ap.length < 12)                            bad.push('ADMIN_PASSWORD must be at least 12 characters');
  if (bad.length) {
    console.error(`\n  ✖ Refusing to start — insecure configuration:\n    - ${bad.join('\n    - ')}` +
      `\n    Set strong values in .env (e.g. SESSION_SECRET="$(openssl rand -hex 32)").\n`);
    process.exit(1);
  }
}

// ─── Token revocation helpers ─────────────────────────────────────────────────
function isRevoked(jti) {
  if (!jti) return false;
  revokedDb();
  return !!_isRevokedSt.get(jti);
}
export function revokeToken(token) {
  const data = decodeToken(token);
  if (!data?.jti) return false;
  revokedDb();
  _revokeStmt.run(data.jti, data.exp);
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
  // Bootstrap: create the head-of-IT account on first run (top of the hierarchy)
  const generated = !process.env.ADMIN_PASSWORD;
  const password  = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const users     = { admin: { passwordHash: hashPassword(password), role: 'head_of_it' } };
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

// Read the user store with mtime caching, without triggering admin bootstrap.
let _usersCache = { mtime: 0, data: {} };
function currentUsers() {
  try {
    const stat = fs.statSync(USERS_FILE);
    if (stat.mtimeMs !== _usersCache.mtime) {
      _usersCache = { mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) };
    }
  } catch { return {}; }
  return _usersCache.data;
}

// Full authentication: valid token AND the account still exists. The role is
// taken from the live user store, so deleting a user or changing their role
// takes effect immediately on the next request — active tokens are not trusted
// for identity beyond the username.
export function authenticate(token) {
  const u = verifyToken(token);
  if (!u) return null;
  const rec = currentUsers()[u.username];
  if (!rec) return null;                               // account removed → reject
  return { username: u.username, role: rec.role || 'user', site: rec.site || null };
}

// ─── Roles (ascending privilege tiers) ────────────────────────────────────────
// Higher rank ⇒ more access. Kay Lim's org positions map onto capability tiers.
//   Tier 1 (read-only)         : viewer, hr
//   Tier 2 (QC inspector)      : inspector             (+ legacy 'user')
//   Tier 3 (QC/NCR manager)    : pm, pd                (+ legacy 'supervisor')
//   Tier 4 (full access)       : head_of_it, gm, management  (+ legacy 'admin')
// GM and Management have full view+change access (all QC actions, DB reset,
// audit verify) — but NOT the manpower feature, which is HR/IT only. That carve
// out is enforced by FEATURE_ADMINS / requireFeatureAdmin, which only admits the
// roles listed for a feature (plus head_of_it). So tier 4 passes every role gate
// while still being denied manpower writes unless the role is hr or head_of_it.
export const ROLE_RANK = {
  viewer: 1, hr: 1,
  user: 2, inspector: 2,
  supervisor: 3, pm: 3, pd: 3,
  gm: 4, management: 4, head_of_it: 4, admin: 4,
};
export function rank(role) { return ROLE_RANK[role] || 0; }
export const ROLES = ['viewer', 'hr', 'inspector', 'pm', 'pd', 'gm', 'management', 'head_of_it'];

// HQ roles (tier 4) see all sites; everyone else is scoped to their assigned site.
export function seesAllSites(role) { return rank(role) >= 4; }

// ─── Express middleware ───────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const h    = req.headers.authorization || '';
  const user = authenticate(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized — login required' });
  req.user = user;
  next();
}

// Require the caller's role to be at least `minRole`.
export function requireRole(minRole) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (rank(req.user.role) < rank(minRole))
      return res.status(403).json({ ok: false, error: `Forbidden — requires ${minRole} role or higher` });
    next();
  });
}

// Kept for backward compatibility: admin == head_of_it (top tier).
export const requireAdmin = requireRole('head_of_it');

// ─── Feature-scoped admin ─────────────────────────────────────────────────────
// A feature is administered by specific role(s) regardless of QC tier — e.g. HR
// manages manpower even though HR is read-only for QC. head_of_it always passes.
export const FEATURE_ADMINS = {
  manpower: ['hr'],
};
export function requireFeatureAdmin(feature) {
  return (req, res, next) => requireAuth(req, res, () => {
    const allowed = FEATURE_ADMINS[feature] || [];
    if (req.user.role === 'head_of_it' || req.user.role === 'admin' || allowed.includes(req.user.role))
      return next();
    return res.status(403).json({ ok: false, error: `Forbidden — ${feature} admin role required` });
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
  const [, , cmd, name, pw, role, site] = process.argv;
  const users = readUsers();
  if (cmd === 'add-user' && name && pw) {
    // Accept the named roles; 'admin' stays valid (== head_of_it). Default to
    // least privilege (viewer) if an unknown/empty role is given. The optional
    // <site> scopes non-HQ users to one site (HQ roles see all sites regardless).
    const validRoles = [...ROLES, 'admin'];
    const chosen = validRoles.includes(role) ? role : 'viewer';
    users[name] = { passwordHash: hashPassword(pw), role: chosen, site: site || null };
    writeUsers(users);
    if (!validRoles.includes(role) && role)
      console.log(`Unknown role '${role}' — defaulting to 'viewer'. Valid: ${ROLES.join(', ')}.`);
    if (!seesAllSites(chosen) && !site)
      console.log(`Note: '${name}' is a site-scoped role with no <site> — they will see no site data until assigned one.`);
    console.log(`User '${name}' saved (role: ${users[name].role}${site ? `, site: ${site}` : ''}).`);
  } else if (cmd === 'remove-user' && name) {
    if (!users[name]) { console.log(`No such user '${name}'.`); process.exit(1); }
    delete users[name];
    writeUsers(users);
    console.log(`User '${name}' removed.`);
  } else if (cmd === 'list-users') {
    Object.entries(users).forEach(([n, u]) => console.log(`${n}  (${u.role || 'user'}${u.site ? ' @ ' + u.site : ''})`));
  } else if (cmd === 'compact-revoked') {
    // Remove expired entries from the revocations SQLite DB.
    // SQLite handles concurrent access atomically — no race window.
    const { changes } = revokedDb().prepare('DELETE FROM revocations WHERE exp < ?').run(Date.now());
    console.log(`Compacted: removed ${changes} expired entries.`);
  } else {
    console.log(`Usage:\n  node auth.js add-user <username> <password> [${ROLES.join('|')}] [site]\n  node auth.js remove-user <username>\n  node auth.js list-users\n  node auth.js compact-revoked`);
  }
}
