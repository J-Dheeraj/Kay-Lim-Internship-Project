/**
 * Integration test: Socket.IO site isolation.
 * Spawns the IDD server, connects two site-scoped realtime clients, triggers a
 * Site-A mutation, and asserts the Site-B client receives NOTHING (no cross-site
 * leak) while the Site-A client does.
 */
process.env.SESSION_SECRET = 'socket-test-secret-not-for-production-use';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';

const { hashPassword } = await import('../auth.js');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'klim-sock-'));
const USERS = path.join(DATA, 'users.json');
fs.writeFileSync(USERS, JSON.stringify({
  admin: { passwordHash: hashPassword('pw'), role: 'head_of_it' },
  inspA: { passwordHash: hashPassword('pw'), role: 'inspector', site: 'SBW-N4' },
  inspB: { passwordHash: hashPassword('pw'), role: 'inspector', site: 'TPN-GV' },
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function login(u) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'pw' }),
  });
  return (await r.json()).token;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

test('Socket.IO does not leak one site\'s events to another site', async () => {
  const srv = spawn(process.execPath, ['idd_production_server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, USERS_FILE: USERS,
           SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: 'pw' },
    stdio: 'ignore',
  });
  try {
    // Wait for the server to be ready.
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await sleep(250);
    }
    const [adminT, aT, bT] = await Promise.all([login('admin'), login('inspA'), login('inspB')]);
    assert.ok(adminT && aT && bT, 'all logins succeed');

    // A Site-A element id (via HQ admin).
    const els = await (await fetch(`${BASE}/api/production/elements?site=SBW-N4`,
      { headers: { Authorization: `Bearer ${adminT}` } })).json();
    const elemA = els[0].id;

    const [sa, sb] = await Promise.all([connect(aT), connect(bT)]);
    let aGot = null, bGot = null;
    sa.on('element:updated', d => { aGot = d; });
    sb.on('element:updated', d => { bGot = d; });
    await sleep(300); // let room joins settle

    // Mutate the Site-A element (as the Site-A inspector).
    await fetch(`${BASE}/api/production/elements/${elemA}/status`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${aT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_production' }),
    });
    await sleep(600); // allow event delivery

    assert.equal(aGot?.id, elemA, 'Site-A client received its own site event');
    assert.equal(bGot, null, 'Site-B client received NOTHING (no cross-site leak)');

    sa.close(); sb.close();
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});
