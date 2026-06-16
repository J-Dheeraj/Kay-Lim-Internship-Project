/**
 * Integration test: Power BI report allowlist enforcement.
 * Spawns the ACC backend with POWERBI_ALLOWED_REPORTS set to one UUID, then
 * verifies that requesting an embed token for a *different* UUID is rejected
 * with 403 before any call reaches the live Power BI API. PBI_WORKSPACE_ID is
 * set (so the allowlist gate is reached) but PBI_TENANT_ID/CLIENT_ID/SECRET
 * are left unset — the allowed-report request is expected to fail past the
 * gate (no real credentials), but must NOT be rejected by the allowlist.
 */
process.env.SESSION_SECRET = 'powerbi-test-secret-not-for-production-use';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { hashPassword } = await import('../auth.js');

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'klim-pbi-'));
const USERS = path.join(DATA, 'users.json');
const TEST_PASS = 'test-pbi-allowlist-pw-1';   // ≥12 chars — satisfies assertSecureConfig
fs.writeFileSync(USERS, JSON.stringify({
  admin: { passwordHash: hashPassword(TEST_PASS), role: 'head_of_it' },
}));

const ALLOWED_REPORT = '11111111-1111-1111-1111-111111111111';
const OTHER_REPORT   = '22222222-2222-2222-2222-222222222222';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: TEST_PASS }),
  });
  return (await r.json()).token;
}

test('Power BI embed endpoint rejects reports outside the application allowlist', async () => {
  const srv = spawn(process.execPath, ['acc_backend_server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
      // Set just enough so the embed route's allowlist gate is reached
      // (wsId must be truthy) without configuring real Power BI credentials.
      PBI_WORKSPACE_ID: 'dummy-workspace-id',
      POWERBI_ALLOWED_REPORTS: ALLOWED_REPORT,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await sleep(250);
    }
    const token = await login();
    assert.ok(token, 'login succeeds');

    // Report NOT in the allowlist → 403, rejected before any PBI API call.
    const rejected = await fetch(`${BASE}/api/powerbi-embed?reportId=${OTHER_REPORT}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(rejected.status, 403);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.error, 'Report not in application allowlist');

    // Report IN the allowlist → passes the gate (fails later for lack of real
    // PBI credentials, but must not be a 403 allowlist rejection).
    const allowed = await fetch(`${BASE}/api/powerbi-embed?reportId=${ALLOWED_REPORT}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.notEqual(allowed.status, 403);
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => srv.once('exit', r));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});
