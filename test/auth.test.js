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
import {
  hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireAdmin, revokeToken,
} from '../auth.js';

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
  fs.rmSync(new URL('../.revoked.json', import.meta.url), { force: true });
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
