/**
 * Integration tests: INTEGRATIONS_STRICT=1 enforced across all mock-capable routes.
 * Spawns server.js with no vendor credentials; with STRICT on, every integration
 * route must return 502 (not 200 mock). Without STRICT, same routes return 200 mock.
 */
process.env.SESSION_SECRET = 'strict-test-secret-not-for-production-use';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { hashPassword, signToken } = await import('../auth.js');

const PORT_STRICT  = 3093;
const PORT_LENIENT = 3092;
const BASE_STRICT  = `http://127.0.0.1:${PORT_STRICT}`;
const BASE_LENIENT = `http://127.0.0.1:${PORT_LENIENT}`;
const TEST_PASS    = 'strict-test-pw-x7q';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealthy(base, maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

function makeData(suffix) {
  const DATA  = fs.mkdtempSync(path.join(os.tmpdir(), `klim-strict-${suffix}-`));
  const USERS = path.join(DATA, 'users.json');
  fs.writeFileSync(USERS, JSON.stringify({
    admin: { passwordHash: hashPassword(TEST_PASS), role: 'head_of_it' },
  }));
  return { DATA, USERS };
}

async function login(base) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: TEST_PASS }),
  });
  const { token } = await r.json();
  return token;
}

let srvStrict, srvLenient, tokenStrict, tokenLenient;

test('before — start strict server (INTEGRATIONS_STRICT=1, no vendor creds)', async () => {
  const { DATA, USERS } = makeData('strict');
  srvStrict = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT_STRICT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
      INTEGRATIONS_STRICT: '1',
      // Explicitly absent: APS_*, PBI_*, QSE_*, UNICON_*
      APS_CLIENT_ID: '', APS_CLIENT_SECRET: '', ACC_ACCOUNT_ID: '', ACC_PROJECT_ID: '',
      PBI_TENANT_ID: '', PBI_CLIENT_ID: '', PBI_CLIENT_SECRET: '', PBI_WORKSPACE_ID: '', PBI_REPORT_ID: '',
      QSE_BASE_URL: '', QSE_API_KEY: '',
      UNICON_API_KEY: '', UNICON_COMPANY_ID: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srvStrict.stderr.on('data', d => process.stderr.write('[strict] ' + d));
  assert.ok(await waitHealthy(BASE_STRICT), 'strict server became healthy');
  tokenStrict = await login(BASE_STRICT);
  assert.ok(tokenStrict, 'obtained auth token from strict server');
});

test('before — start lenient server (no INTEGRATIONS_STRICT, no vendor creds)', async () => {
  const { DATA, USERS } = makeData('lenient');
  srvLenient = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT_LENIENT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
      INTEGRATIONS_STRICT: '',
      APS_CLIENT_ID: '', APS_CLIENT_SECRET: '', ACC_ACCOUNT_ID: '', ACC_PROJECT_ID: '',
      PBI_TENANT_ID: '', PBI_CLIENT_ID: '', PBI_CLIENT_SECRET: '', PBI_WORKSPACE_ID: '', PBI_REPORT_ID: '',
      QSE_BASE_URL: '', QSE_API_KEY: '',
      UNICON_API_KEY: '', UNICON_COMPANY_ID: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srvLenient.stderr.on('data', d => process.stderr.write('[lenient] ' + d));
  assert.ok(await waitHealthy(BASE_LENIENT), 'lenient server became healthy');
  tokenLenient = await login(BASE_LENIENT);
  assert.ok(tokenLenient, 'obtained auth token from lenient server');
});

// Routes that must 502 in strict mode and 200 mock in lenient mode
const STRICT_ROUTES = [
  '/api/rfis',
  '/api/issues',
  '/api/defects',
  '/api/progress',
  '/api/idd/production',
  '/api/idd/logistics',
];

for (const route of STRICT_ROUTES) {
  test(`STRICT: ${route} returns 502 with _source: error`, async () => {
    const r = await fetch(`${BASE_STRICT}${route}`, {
      headers: { Authorization: `Bearer ${tokenStrict}` },
    });
    assert.equal(r.status, 502, `${route} should be 502 in strict mode`);
    const body = await r.json();
    assert.equal(body._source, 'error', `${route} body._source should be 'error'`);
  });

  test(`LENIENT: ${route} returns 200 mock`, async () => {
    const r = await fetch(`${BASE_LENIENT}${route}`, {
      headers: { Authorization: `Bearer ${tokenLenient}` },
    });
    assert.equal(r.status, 200, `${route} should be 200 in lenient mode`);
    const body = await r.json();
    assert.equal(body._source, 'mock', `${route} body._source should be 'mock'`);
  });
}

test('STRICT: /api/powerbi-embed returns 502 when no PBI creds', async () => {
  const r = await fetch(`${BASE_STRICT}/api/powerbi-embed`, {
    headers: { Authorization: `Bearer ${tokenStrict}` },
  });
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body._source, 'error');
  assert.equal(body.source, 'powerbi-embed');
});

test('LENIENT: /api/powerbi-embed returns 200 mock when no PBI creds', async () => {
  const r = await fetch(`${BASE_LENIENT}/api/powerbi-embed`, {
    headers: { Authorization: `Bearer ${tokenLenient}` },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body._source, 'mock');
});

test('/api/progress requires auth — returns 401 without token', async () => {
  const r = await fetch(`${BASE_LENIENT}/api/progress`);
  assert.equal(r.status, 401);
});

test('after — kill servers', async () => {
  srvStrict?.kill();
  srvLenient?.kill();
  await sleep(200);
});
