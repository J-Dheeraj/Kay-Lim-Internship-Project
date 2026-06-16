/**
 * Unit tests for the authentication module.
 * Run: npm test   (uses the built-in node:test runner — no extra deps)
 *
 * Uses a fixed SESSION_SECRET so token signatures are deterministic and the
 * test does not depend on (or create) the on-disk .session_secret file.
 */
process.env.SESSION_SECRET = 'test-secret-do-not-use-in-production';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the auth module at a throwaway user store so the middleware lifecycle
// checks have known users without touching any real users.json.
const USERS_FILE = path.join(os.tmpdir(), `klim-test-users-${process.pid}.json`);
fs.writeFileSync(USERS_FILE, JSON.stringify({
  carol: { passwordHash: 'x', role: 'user'  },
  dan:   { passwordHash: 'x', role: 'user'  },
  eve:   { passwordHash: 'x', role: 'admin' },
  grace: { passwordHash: 'x', role: 'user'  },
  vic:   { passwordHash: 'x', role: 'viewer' },
  ines:  { passwordHash: 'x', role: 'inspector' },
  sam:   { passwordHash: 'x', role: 'supervisor' },
  hank:  { passwordHash: 'x', role: 'head_of_it' },
  peggy: { passwordHash: 'x', role: 'pm' },         // org role → manager tier (3)
  holly: { passwordHash: 'x', role: 'hr' },         // org role → read-only
  gina:  { passwordHash: 'x', role: 'gm' },         // org role → full access except manpower (4)
}));
process.env.USERS_FILE = USERS_FILE;
process.on('exit', () => { try { fs.rmSync(USERS_FILE, { force: true }); } catch {} });

// Dynamic import so the env vars above are in place before auth.js evaluates
// (static imports are hoisted and would run first).
const {
  hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireAdmin,
  revokeToken, authenticate, requireRole, rank, requireFeatureAdmin, seesAllSites,
} = await import('../auth.js');

// Express middleware harness.
function run(mw, username) {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json   = b => { res.body = b; return res; };
  let nexted = false;
  const headers = username ? { authorization: 'Bearer ' + signToken(username, 'ignored') } : {};
  mw({ headers }, res, () => { nexted = true; });
  return { nexted, status: res.statusCode };
}

test('password hashing round-trips and rejects wrong passwords', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('same password produces different hashes (random salt)', () => {
  assert.notEqual(hashPassword('hunter2'), hashPassword('hunter2'));
});

test('verifyPassword tolerates malformed stored values', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', undefined), false);
});

test('signed token round-trips username and role', () => {
  const user = verifyToken(signToken('alice', 'admin'));
  assert.deepEqual(user, { username: 'alice', role: 'admin' });
});

test('tampered token is rejected', () => {
  const token = signToken('bob', 'user');
  assert.equal(verifyToken(token + 'x'), null);                 // mutated signature
  const [payload, sig] = token.split('.');
  assert.equal(verifyToken('eyJtYW5nbGVkIjoxfQ.' + sig), null); // mutated payload
});

test('non-string / empty token is rejected', () => {
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('no-dot'), null);
});

test('expired token is rejected', () => {
  // Hand-craft a validly-signed token whose exp is in the past.
  const payload = Buffer.from(JSON.stringify({
    sub: 'frank', role: 'user', exp: Date.now() - 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload).digest('base64url');
  assert.equal(verifyToken(`${payload}.${sig}`), null);
});

test('revoked token is rejected after logout', () => {
  const token = signToken('grace', 'user');
  assert.equal(verifyToken(token).username, 'grace');  // valid before revoke
  revokeToken(token);
  assert.equal(verifyToken(token), null);              // rejected after revoke
  // A different (non-revoked) token still works
  assert.equal(verifyToken(signToken('grace', 'user')).username, 'grace');
});

// This test file doesn't set DATA_DIR, so auth.js's revocations.db (created
// above by revokeToken()) lands in the project root by default. Clean it up
// on exit so repeated local test runs don't leave stray SQLite files behind.
process.on('exit', () => {
  for (const f of ['revocations.db', 'revocations.db-wal', 'revocations.db-shm']) {
    try { fs.rmSync(new URL('../' + f, import.meta.url), { force: true }); } catch {}
  }
});

test('authenticate rejects a valid token whose account no longer exists', () => {
  // mallory has a cryptographically valid token but is not in the user store.
  assert.equal(verifyToken(signToken('mallory', 'user')) !== null, true); // token itself is valid
  assert.equal(authenticate(signToken('mallory', 'user')), null);          // but account is gone
});

test('authenticate takes the role from the store, not the token', () => {
  // dan is a 'user' in the store even though the token claims 'admin'.
  assert.equal(authenticate(signToken('dan', 'admin')).role, 'user');
});

test('requireAuth blocks missing/invalid tokens and admits valid ones', () => {
  const mkRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = c => { r.statusCode = c; return r; };
    r.json   = b => { r.body = b; return r; };
    return r;
  };

  // No header -> 401
  let res = mkRes(), called = false;
  requireAuth({ headers: {} }, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);

  // Valid bearer -> next() called, req.user populated
  res = mkRes(); called = false;
  const req = { headers: { authorization: 'Bearer ' + signToken('carol', 'user') } };
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.username, 'carol');
});

test('requireAdmin forbids non-admins and admits admins', () => {
  const mkRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = c => { r.statusCode = c; return r; };
    r.json   = b => { r.body = b; return r; };
    return r;
  };

  // user role -> 403
  let res = mkRes(), called = false;
  requireAdmin({ headers: { authorization: 'Bearer ' + signToken('dan', 'user') } }, res, () => { called = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(called, false);

  // admin role -> next()
  res = mkRes(); called = false;
  requireAdmin({ headers: { authorization: 'Bearer ' + signToken('eve', 'admin') } }, res, () => { called = true; });
  assert.equal(called, true);
});

test('role ranks order correctly, legacy roles mapped', () => {
  assert.ok(rank('viewer') < rank('inspector'));
  assert.ok(rank('inspector') < rank('supervisor'));
  assert.ok(rank('supervisor') < rank('head_of_it'));
  assert.equal(rank('admin'), rank('head_of_it'));  // legacy admin == top
  assert.equal(rank('user'), rank('inspector'));     // legacy user == inspector level
});

test('requireRole enforces the minimum role (inspector gate)', () => {
  const gate = requireRole('inspector');
  assert.equal(run(gate, 'vic').status, 403);    // viewer  < inspector
  assert.equal(run(gate, 'ines').nexted, true);  // inspector ok
  assert.equal(run(gate, 'sam').nexted, true);   // supervisor ok (higher)
  assert.equal(run(gate, 'hank').nexted, true);  // head_of_it ok
  assert.equal(run(gate, null).status, 401);     // unauthenticated
});

test('separation of duties: inspector cannot close NCRs (supervisor gate)', () => {
  const gate = requireRole('supervisor');
  assert.equal(run(gate, 'ines').status, 403);   // inspector blocked from closing
  assert.equal(run(gate, 'sam').nexted, true);   // supervisor can close
  assert.equal(run(gate, 'hank').nexted, true);  // head_of_it can close
});

test('top gate (reset/audit): head_of_it + GM/Management pass, PM/supervisor do not', () => {
  const gate = requireRole('head_of_it');
  assert.equal(run(gate, 'sam').status, 403);    // supervisor blocked
  assert.equal(run(gate, 'peggy').status, 403);  // PM (manager) blocked
  assert.equal(run(gate, 'gina').nexted, true);  // GM has full access
  assert.equal(run(gate, 'hank').nexted, true);  // head_of_it ok
  assert.equal(run(gate, 'eve').nexted, true);   // legacy admin == head_of_it
});

test('feature-scoped admin: HR manages manpower, QC roles do not', () => {
  const gate = requireFeatureAdmin('manpower');
  assert.equal(run(gate, 'holly').nexted, true);   // HR can manage manpower
  assert.equal(run(gate, 'hank').nexted, true);     // head_of_it always can
  assert.equal(run(gate, 'peggy').status, 403);     // PM (manager) cannot — wrong feature
  assert.equal(run(gate, 'gina').status, 403);      // GM has full access EXCEPT manpower
  assert.equal(run(gate, 'ines').status, 403);      // inspector cannot
  assert.equal(run(gate, 'vic').status, 403);       // viewer cannot
  assert.equal(run(gate, null).status, 401);        // unauthenticated
});

test('seesAllSites: HQ roles see all sites, others are site-scoped', () => {
  for (const r of ['head_of_it', 'admin', 'gm', 'management']) assert.equal(seesAllSites(r), true);
  for (const r of ['pd', 'pm', 'supervisor', 'inspector', 'hr', 'viewer']) assert.equal(seesAllSites(r), false);
});

test('org positions map to the right tiers', () => {
  // PM (manager tier) can close NCRs; HR (read-only) cannot mutate; neither is system admin.
  assert.equal(run(requireRole('supervisor'), 'peggy').nexted, true);  // PM can close NCRs
  assert.equal(run(requireRole('supervisor'), 'holly').status, 403);   // HR cannot close
  assert.equal(run(requireRole('inspector'),  'holly').status, 403);   // HR cannot do QC actions
  assert.equal(run(requireRole('inspector'),  'peggy').nexted, true);  // PM ≥ inspector
  assert.equal(run(requireRole('head_of_it'), 'peggy').status, 403);   // PM is not system admin
});
