/**
 * Integration tests: UniCon validation, audit persistence, before/after audit, cascade delete.
 * Spawns server.js on a temp port with a temp data directory.
 */
process.env.SESSION_SECRET = 'uc-test-secret-not-for-production-use';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const { hashPassword } = await import('../auth.js');

const PORT     = 3095;
const BASE     = `http://127.0.0.1:${PORT}`;
const TEST_PASS = 'uc-test-pw-z9r';
const DATA     = fs.mkdtempSync(path.join(os.tmpdir(), 'klim-uc-test-'));
const USERS    = path.join(DATA, 'users.json');
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

let srv, token;

test('before — start server', async () => {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(PORT), DATA_DIR: DATA, USERS_FILE: USERS,
      SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_PASSWORD: TEST_PASS,
      INTEGRATIONS_STRICT: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[uc-srv] ' + d));
  assert.ok(await waitHealthy(), 'server became healthy');
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: TEST_PASS }),
  });
  ({ token } = await r.json());
  assert.ok(token, 'obtained auth token');
});

const AUTH = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// ── Validation: projects ───────────────────────────────────────────────────

test('POST /api/uc/projects rejects invalid status', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST',
    headers: AUTH(),
    body: JSON.stringify({ name: 'Test', status: 'banana' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(Array.isArray(errors));
  assert.ok(errors.some(e => e.includes('status must be one of')));
});

test('POST /api/uc/projects rejects non-numeric progress', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST',
    headers: AUTH(),
    body: JSON.stringify({ name: 'Test', progress: 'abc' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('progress') && e.includes('number')));
});

test('POST /api/uc/projects rejects out-of-range progress', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST',
    headers: AUTH(),
    body: JSON.stringify({ name: 'Test', progress: 150 }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('progress') && e.includes('100')));
});

test('POST /api/uc/projects rejects impossible calendar date', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST',
    headers: AUTH(),
    body: JSON.stringify({ name: 'Test', due_date: '2026-13-99' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('due_date')));
});

test('POST /api/uc/projects rejects negative budget_sgd', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST',
    headers: AUTH(),
    body: JSON.stringify({ name: 'Test', budget_sgd: -1 }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('budget_sgd')));
});

test('PUT /api/uc/projects rejects non-numeric budget_sgd', async () => {
  // Create a project first
  const cr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ name: 'Budget Test Project' }),
  });
  const { id } = await cr.json();
  const r = await fetch(`${BASE}/api/uc/projects/${id}`, {
    method: 'PUT', headers: AUTH(),
    body: JSON.stringify({ budget_sgd: 'nope' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('budget_sgd') && e.includes('number')));
});

// ── Validation: tasks ──────────────────────────────────────────────────────

test('POST /api/uc/tasks rejects invalid priority', async () => {
  const pr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(), body: JSON.stringify({ name: 'Task Test Project' }),
  });
  const { id: project_id } = await pr.json();
  const r = await fetch(`${BASE}/api/uc/tasks`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ title: 'T1', project_id, priority: 'extreme' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('priority')));
});

test('POST /api/uc/tasks rejects impossible due_date', async () => {
  const pr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(), body: JSON.stringify({ name: 'Task Date Project' }),
  });
  const { id: project_id } = await pr.json();
  const r = await fetch(`${BASE}/api/uc/tasks`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ title: 'T2', project_id, due_date: '2026-02-30' }),
  });
  assert.equal(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some(e => e.includes('due_date')));
});

// ── Audit persistence ──────────────────────────────────────────────────────

test('CREATE project writes a uc_audit row', async () => {
  const r = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ name: 'Audit Create Test', status: 'active' }),
  });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const ucDb = new Database(path.join(DATA, 'uc.db'), { readonly: true });
  const row = ucDb.prepare("SELECT * FROM uc_audit WHERE entity_id=? AND action='project.create'").get(id);
  ucDb.close();
  assert.ok(row, 'audit row exists for project.create');
  assert.ok(row.actor, 'audit row has actor');
  assert.equal(row.entity_id, id);
});

test('UPDATE project writes a uc_audit row with before state', async () => {
  const cr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ name: 'Audit Update Test' }),
  });
  const { id } = await cr.json();
  await fetch(`${BASE}/api/uc/projects/${id}`, {
    method: 'PUT', headers: AUTH(),
    body: JSON.stringify({ name: 'Audit Update Test — renamed' }),
  });
  const ucDb = new Database(path.join(DATA, 'uc.db'), { readonly: true });
  const row = ucDb.prepare("SELECT * FROM uc_audit WHERE entity_id=? AND action='project.update'").get(id);
  ucDb.close();
  assert.ok(row, 'audit row exists for project.update');
  const detail = JSON.parse(row.detail);
  assert.ok(detail.before, 'audit detail includes before state');
  assert.equal(detail.before.name, 'Audit Update Test');
});

test('DELETE project writes a uc_audit row', async () => {
  const cr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ name: 'Audit Delete Test' }),
  });
  const { id } = await cr.json();
  await fetch(`${BASE}/api/uc/projects/${id}`, { method: 'DELETE', headers: AUTH() });
  const ucDb = new Database(path.join(DATA, 'uc.db'), { readonly: true });
  const row = ucDb.prepare("SELECT * FROM uc_audit WHERE entity_id=? AND action='project.delete'").get(id);
  ucDb.close();
  assert.ok(row, 'audit row exists for project.delete');
});

// ── Cascade delete ─────────────────────────────────────────────────────────

test('DELETE project cascades to tasks', async () => {
  const pr = await fetch(`${BASE}/api/uc/projects`, {
    method: 'POST', headers: AUTH(),
    body: JSON.stringify({ name: 'Cascade Project' }),
  });
  const { id: project_id } = await pr.json();

  for (const title of ['Task A', 'Task B']) {
    await fetch(`${BASE}/api/uc/tasks`, {
      method: 'POST', headers: AUTH(),
      body: JSON.stringify({ title, project_id }),
    });
  }

  // Verify tasks exist
  const before = await (await fetch(`${BASE}/api/uc/tasks`, { headers: AUTH() })).json();
  const beforeCount = before.tasks.filter(t => t.project_id === project_id).length;
  assert.equal(beforeCount, 2, 'two tasks exist before delete');

  // Delete project
  const dr = await fetch(`${BASE}/api/uc/projects/${project_id}`, { method: 'DELETE', headers: AUTH() });
  assert.equal(dr.status, 200);

  // Verify tasks gone
  const after = await (await fetch(`${BASE}/api/uc/tasks`, { headers: AUTH() })).json();
  const afterCount = after.tasks.filter(t => t.project_id === project_id).length;
  assert.equal(afterCount, 0, 'tasks are deleted when project is deleted');
});

test('after — kill server and clean up', async () => {
  srv?.kill();
  await sleep(200);
  fs.rmSync(DATA, { recursive: true, force: true });
});
