/**
 * Integration test: Content-Security-Policy header present on the unified server.
 * Spawns server.js (port 3099) with minimal env, fetches / and /idd, and asserts
 * the CSP header is set with expected directives for both apps.
 */
process.env.SESSION_SECRET = 'security-headers-test-secret-not-prod';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { hashPassword } = await import('../auth.js');

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'klim-csp-'));
const USERS = path.join(DATA, 'users.json');
const TEST_PASS = 'test-csp-headers-pw-1';
fs.writeFileSync(USERS, JSON.stringify({
  admin: { passwordHash: hashPassword(TEST_PASS), role: 'head_of_it' },
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealthy(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

let srv;

test('before — start unified server', async () => {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
  assert.ok(await waitHealthy(), 'unified server became healthy');
});

test('Command Centre (/) sets correct CSP directives', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'content-security-policy header is present');
  assert.ok(csp.includes("default-src 'self'"), "CSP contains default-src 'self'");
  assert.ok(csp.includes('frame-src https://app.powerbi.com'), 'CSP allows Power BI frame');
  assert.ok(csp.includes('https://cdnjs.cloudflare.com'), 'CSP allows cdnjs for Chart.js');
  assert.ok(csp.includes('ws: wss:'), 'CSP allows WebSocket connections for Socket.IO');
  assert.ok(!csp.match(/style-src[^;]*'unsafe-inline'/), "CSP style-src does not contain 'unsafe-inline'");

  const html = await res.text();
  assert.ok(!/<script(?![^>]*\bsrc\s*=)[^>]*>[^<\s]/.test(html),
    'ACC root page has no inline <script> content block');
  assert.ok(html.includes('src="/construction_dashboard.js"'),
    'ACC root references external /construction_dashboard.js');
});

test('/construction_dashboard.js is served with correct content-type', async () => {
  const res = await fetch(`${BASE}/construction_dashboard.js`);
  assert.strictEqual(res.status, 200, '/construction_dashboard.js returns 200');
  const ct = res.headers.get('content-type') ?? '';
  assert.ok(ct.includes('javascript') || ct.includes('application/js'),
    '/construction_dashboard.js content-type is JavaScript');
});

test('/construction_dashboard.css is served with correct content-type', async () => {
  const res = await fetch(`${BASE}/construction_dashboard.css`);
  assert.strictEqual(res.status, 200, '/construction_dashboard.css returns 200');
  assert.ok((res.headers.get('content-type') ?? '').includes('text/css'),
    '/construction_dashboard.css content-type is text/css');
});

test('IDD Production (/idd) sets correct CSP directives', async () => {
  const res = await fetch(`${BASE}/idd`);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'content-security-policy header is present on /idd');
  assert.ok(csp.includes("default-src 'self'"), "CSP contains default-src 'self'");
  assert.ok(csp.includes('ws: wss:'), 'CSP allows WebSocket connections for Socket.IO');
  assert.ok(csp.includes('https://cdnjs.cloudflare.com'), 'CSP allows cdnjs for Chart.js');
  assert.ok(!csp.match(/style-src[^;]*'unsafe-inline'/), "CSP style-src does not contain 'unsafe-inline'");

  const html = await res.text();
  assert.ok(!/<script(?![^>]*\bsrc\s*=)[^>]*>[^<\s]/.test(html),
    'IDD root page has no inline <script> content block');
  assert.ok(html.includes('src="/idd_production_app.js"'),
    'IDD page references external /idd_production_app.js');
});

test('/idd_production_app.js is served with correct content-type', async () => {
  const res = await fetch(`${BASE}/idd_production_app.js`);
  assert.strictEqual(res.status, 200, '/idd_production_app.js returns 200');
  const ct = res.headers.get('content-type') ?? '';
  assert.ok(ct.includes('javascript') || ct.includes('application/js'),
    '/idd_production_app.js content-type is JavaScript');
});

test('/idd_production_app.css is served with correct content-type', async () => {
  const res = await fetch(`${BASE}/idd_production_app.css`);
  assert.strictEqual(res.status, 200, '/idd_production_app.css returns 200');
  assert.ok((res.headers.get('content-type') ?? '').includes('text/css'),
    '/idd_production_app.css content-type is text/css');
});

test('after — stop server', async () => {
  srv.kill('SIGTERM');
  await new Promise(r => srv.once('exit', r));
  fs.rmSync(DATA, { recursive: true, force: true });
});
