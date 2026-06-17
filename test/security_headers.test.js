/**
 * Integration test: Content-Security-Policy header present on both servers.
 * Spawns ACC (port 3099) and IDD (port 3100) with minimal env, fetches the
 * root page from each, and asserts the CSP header is set with expected directives.
 */
process.env.SESSION_SECRET = 'security-headers-test-secret-not-prod';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { hashPassword } = await import('../auth.js');

const ACC_PORT = 3099;
const IDD_PORT = 3100;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'klim-csp-'));
const USERS = path.join(DATA, 'users.json');
const TEST_PASS = 'test-csp-headers-pw-1';
fs.writeFileSync(USERS, JSON.stringify({
  admin: { passwordHash: hashPassword(TEST_PASS), role: 'head_of_it' },
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealthy(port, maxMs = 20000) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

test('ACC server sets Content-Security-Policy with required directives', async () => {
  const srv = spawn(process.execPath, ['acc_backend_server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(ACC_PORT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[acc] ' + d));
  try {
    assert.ok(await waitHealthy(ACC_PORT), 'ACC server became healthy');
    const res = await fetch(`http://127.0.0.1:${ACC_PORT}/`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'content-security-policy header is present');
    assert.ok(csp.includes("default-src 'self'"), "CSP contains default-src 'self'");
    assert.ok(csp.includes('frame-src https://app.powerbi.com'), 'CSP allows Power BI frame');
    assert.ok(csp.includes('https://cdnjs.cloudflare.com'), 'CSP allows cdnjs for Chart.js');
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => srv.once('exit', r));
  }
});

test('IDD server sets Content-Security-Policy with required directives', async () => {
  const srv = spawn(process.execPath, ['idd_production_server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(IDD_PORT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[idd] ' + d));
  try {
    assert.ok(await waitHealthy(IDD_PORT), 'IDD server became healthy');
    const res = await fetch(`http://127.0.0.1:${IDD_PORT}/`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'content-security-policy header is present');
    assert.ok(csp.includes("default-src 'self'"), "CSP contains default-src 'self'");
    assert.ok(csp.includes('ws: wss:'), 'CSP allows WebSocket connections for Socket.IO');
    assert.ok(csp.includes('https://cdnjs.cloudflare.com'), 'CSP allows cdnjs for Chart.js');
  } finally {
    srv.kill('SIGTERM');
    await new Promise(r => srv.once('exit', r));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});
