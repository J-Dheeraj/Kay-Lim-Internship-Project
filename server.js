/**
 * Kay Lim Construction — Unified Backend Server
 * Node.js / Express + Socket.io
 *
 * Serves both apps from one process on one port:
 *   /          → construction_dashboard.html  (Command Centre)
 *   /idd       → idd_production_app.html      (IDD Digital Production)
 *   /api/*     → REST API (ACC proxy, UniCon CRUD, manpower, IDD production/NCR)
 *   /socket.io → Socket.io real-time feed (IDD)
 *
 * Run:  node server.js   (or npm start)
 * Port: 3001 (configurable via PORT env var)
 *
 * Real integrations:
 *   ✅  Autodesk Platform Services (APS) — 2-legged OAuth + Issues API v1 + Quality Checklists v1
 *   ✅  Power BI Embedded — Azure AD service-principal auth + Reports + GenerateToken
 *   ✅  IDD Digital Production — SQLite (idd.db), real-time via Socket.io
 *   ⏳  Insight QSE (CAPPS) — mock; contact CAPPS (contact@capps.com.sg / +65 6509 0309) for API key
 *   ⏳  UniCon external API — mock; using local SQLite instead (uc.db)
 */

import express from 'express';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createStore } from './idd_store.js';
import {
  requireAuth, requireAdmin, requireRole, loginHandler, logoutHandler,
  requireFeatureAdmin, assertSecureConfig, makeServer,
  purgeExpiredRevocations, authenticate, seesAllSites, closeRevokedDb,
} from './auth.js';
import { makeLogger } from './logger.js';
import { validateConfig, ACC_SCHEMA } from './config-schema.js';

assertSecureConfig();   // refuse to boot with example/placeholder secrets

const log = makeLogger('app');
const { errors: cfgErrors, warnings: cfgWarnings } = validateConfig(process.env, ACC_SCHEMA);
cfgWarnings.forEach(w => log.warn('config', { detail: w }));
if (cfgErrors.length) { cfgErrors.forEach(e => log.error('config', { detail: e })); process.exit(1); }

{ const n = purgeExpiredRevocations(); if (n) log.info('startup', { msg: 'revocation compaction', purged: n }); }
setInterval(() => { const n = purgeExpiredRevocations(); if (n) log.info('revocation-compaction', { purged: n }); }, 60 * 60 * 1000).unref();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3001;
const DB_FILE   = process.env.IDD_DB_FILE || path.join(process.env.DATA_DIR || __dirname, 'idd.db');

// ─────────────────────────────────────────────────────────────────────────────
// Power BI allowlist + strict-integration guard
// ─────────────────────────────────────────────────────────────────────────────
const PBI_ALLOWED = new Set(
  (process.env.POWERBI_ALLOWED_REPORTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const STRICT_INTEGRATIONS = /^(1|true|strict|on)$/i.test(process.env.INTEGRATIONS_STRICT || '');
const PBI_CONFIGURED = !!(process.env.PBI_WORKSPACE_ID && process.env.PBI_TENANT_ID &&
                           process.env.PBI_CLIENT_ID && process.env.PBI_CLIENT_SECRET);
if (STRICT_INTEGRATIONS && PBI_CONFIGURED && PBI_ALLOWED.size === 0) {
  console.error('\n  ✖ Refusing to start — Power BI is configured but POWERBI_ALLOWED_REPORTS is empty.' +
    '\n    Set POWERBI_ALLOWED_REPORTS in .env to the report UUID(s) this deployment may embed.\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Express + Socket.io setup
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

const ALLOWED = (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes(o)) ? cb(null, true) : cb(new Error('CORS blocked: ' + o)) }));
app.use(express.json({ limit: '50kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com 'wasm-unsafe-eval'; " +
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "worker-src blob:; " +
    "frame-src https://app.powerbi.com;"
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request ID + access log
app.use((req, res, next) => {
  req.reqId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.reqId);
  const t0 = Date.now();
  res.on('finish', () => log.info('request', { reqId: req.reqId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
  next();
});

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts — try again in 15 minutes' },
});
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests — slow down' },
});
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests — slow down' },
});
const manpowerLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many manpower updates — slow down' },
});

// Login (rate-limited); auth gate for all other /api routes
app.post('/api/login', loginLimiter, loginHandler);
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/login') return next();
  requireAuth(req, res, next);
});
app.post('/api/logout', logoutHandler);
app.use(['/api/powerbi-embed', '/api/powerbi-reports', '/api/rfis', '/api/defects', '/api/qaqc'], proxyLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving — explicit allow-list only; no express.static on root
// ─────────────────────────────────────────────────────────────────────────────
const sendStatic = f => (_req, res) => res.sendFile(path.join(__dirname, f));

// Command Centre (ACC dashboard)
app.get('/',                           sendStatic('construction_dashboard.html'));
app.get('/construction_dashboard.js',  sendStatic('construction_dashboard.js'));
app.get('/construction_dashboard.css', sendStatic('construction_dashboard.css'));

// IDD Digital Production app
app.get('/idd',                        sendStatic('idd_production_app.html'));
app.get('/idd_production_app.html',    (_req, res) => res.redirect('/idd'));
app.get('/idd_production_app.js',      sendStatic('idd_production_app.js'));
app.get('/idd_production_app.css',     sendStatic('idd_production_app.css'));

// Shared navigation widget
app.get('/nav.js',  sendStatic('nav.js'));
app.get('/nav.css', sendStatic('nav.css'));

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server + Socket.io
// ─────────────────────────────────────────────────────────────────────────────
const { server, tls } = makeServer(app);
const io = new SocketIO(server, {
  cors: { origin: ALLOWED, methods: ['GET','POST','PATCH','DELETE'] },
});

// ─────────────────────────────────────────────────────────────────────────────
// Database initialisation
// ─────────────────────────────────────────────────────────────────────────────

// ── UniCon internal DB ────────────────────────────────────────────────────────
const ucDb = new Database(path.join(process.env.DATA_DIR || __dirname, 'uc.db'));
ucDb.pragma('journal_mode = WAL');
ucDb.pragma('foreign_keys = ON');
ucDb.exec(`
  CREATE TABLE IF NOT EXISTS uc_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    progress INTEGER NOT NULL DEFAULT 0, budget_sgd REAL NOT NULL DEFAULT 0,
    spent_sgd REAL NOT NULL DEFAULT 0, due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS uc_tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES uc_projects(id),
    title TEXT NOT NULL, assigned_to TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'med', due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS uc_members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS uc_subcontractors (
    id TEXT PRIMARY KEY, company TEXT NOT NULL, trade TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', workers INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS uc_audit (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    at   TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    ip   TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT
  );
`);
(ucDb.transaction(() => {
  if (!ucDb.prepare('SELECT 1 FROM uc_projects LIMIT 1').get()) {
    const ip = ucDb.prepare('INSERT INTO uc_projects (id,name,status,progress,budget_sgd,spent_sgd,due_date) VALUES (?,?,?,?,?,?,?)');
    ip.run('p1','Sembawang Block 312 (HDB)','active',68,42000000,28560000,'2027-03-31');
    ip.run('p2','Jurong West RC Frame (MUP)','active',26,15000000,3900000,'2027-12-31');
    ip.run('p3','Tampines PPVC Residential','active',17,28000000,4760000,'2028-06-30');
  }
  if (!ucDb.prepare('SELECT 1 FROM uc_tasks LIMIT 1').get()) {
    const it = ucDb.prepare('INSERT INTO uc_tasks (id,project_id,title,assigned_to,priority,due_date,status) VALUES (?,?,?,?,?,?,?)');
    it.run('t1','p1','Install formwork L5 Col C3','Ahmad Fauzi','high','2026-06-10','in_progress');
    it.run('t2','p1','M&E roughing L4 Zone A','Lim Ah Kow','med','2026-06-11','open');
    it.run('t3','p2','RC raft foundation pour','Chan Beng Hwa','high','2026-06-08','overdue');
    it.run('t4','p1','Hoist maintenance check','Wong Kai Feng','low','2026-06-10','open');
    it.run('t5','p3','PPVC module delivery TT22','Rajan Kumar','med','2026-06-12','open');
  }
  if (!ucDb.prepare('SELECT 1 FROM uc_members LIMIT 1').get()) {
    const im = ucDb.prepare('INSERT INTO uc_members (id,name,role) VALUES (?,?,?)');
    ['Ahmad Kadir|Site Manager','Lim Boon Huat|M&E Coordinator','Rajan Subramaniam|QA/QC Inspector',
     'Tan Wei Hao|Project Engineer','Lee Kim Wah|Safety Officer'].forEach((s,i)=>{
      const [n,r]=s.split('|'); im.run('m'+(i+1),n,r); });
  }
  if (!ucDb.prepare('SELECT 1 FROM uc_subcontractors LIMIT 1').get()) {
    const is = ucDb.prepare('INSERT INTO uc_subcontractors (id,company,trade,status,workers) VALUES (?,?,?,?,?)');
    [['APS Scaffold Pte Ltd','Scaffolding','active',17],['Sin Hua Metal Works','Structural Steel','active',22],
     ['ETC Electric Pte Ltd','Electrical','active',14],['KL Plumbing & Sanitary','Plumbing','active',12],
     ['Beauty Plaster Pte Ltd','Plastering','active',18],['SG Tiling Works','Tiling','active',10],
     ['Alpha Machinery (Kay Lim)','Crane / Equipment','active',4],['Pacific Landscaping','Landscaping','on_hold',0],
    ].forEach(([co,tr,st,wk],i)=>is.run('s'+(i+1),co,tr,st,wk));
  }
}))();

function ucId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function requireUcAdmin(req, res, next) {
  if (!new Set(['pm','pd','gm','management','head_of_it','admin']).has(req.user?.role))
    return res.status(403).json({ error: 'pm role or above required' });
  next();
}

const UC_PROJECT_STATUSES = new Set(['active','on_hold','completed','cancelled']);
const UC_TASK_STATUSES    = new Set(['open','in_progress','completed','overdue']);
const UC_PRIORITIES       = new Set(['low','med','medium','high','critical']);
const UC_SUB_STATUSES     = new Set(['active','on_hold','completed','cancelled']);
const ISO_DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;

function validateUcProject({ name, status, progress, budget_sgd, spent_sgd, due_date } = {}) {
  const errors = [];
  if (!name?.trim()) errors.push('name required');
  if (status != null && !UC_PROJECT_STATUSES.has(status))
    errors.push(`status must be one of: ${[...UC_PROJECT_STATUSES].join(', ')}`);
  if (progress != null && (Number(progress) < 0 || Number(progress) > 100))
    errors.push('progress must be 0–100');
  if (budget_sgd != null && Number(budget_sgd) < 0) errors.push('budget_sgd must be ≥ 0');
  if (spent_sgd  != null && Number(spent_sgd)  < 0) errors.push('spent_sgd must be ≥ 0');
  if (due_date   != null && !ISO_DATE_RE.test(due_date)) errors.push('due_date must be YYYY-MM-DD');
  return errors;
}

function validateUcTask({ title, project_id, priority, status, due_date } = {}) {
  const errors = [];
  if (!title?.trim()) errors.push('title required');
  if (!project_id)    errors.push('project_id required');
  if (priority != null && !UC_PRIORITIES.has(priority))
    errors.push(`priority must be one of: ${[...UC_PRIORITIES].join(', ')}`);
  if (status != null && !UC_TASK_STATUSES.has(status))
    errors.push(`status must be one of: ${[...UC_TASK_STATUSES].join(', ')}`);
  if (due_date != null && !ISO_DATE_RE.test(due_date)) errors.push('due_date must be YYYY-MM-DD');
  return errors;
}

const _ucAudit = ucDb.prepare(
  'INSERT INTO uc_audit (actor,ip,action,entity_id,detail) VALUES (?,?,?,?,?)'
);
function ucAudit(req, action, entityId, detail = null) {
  const { actor, ip } = auditMeta(req);
  _ucAudit.run(actor, ip, action, entityId, detail ? JSON.stringify(detail) : null);
}

// ── Manpower DB ───────────────────────────────────────────────────────────────
const mpDb = new Database(process.env.ACC_DB_FILE || path.join(process.env.DATA_DIR || __dirname, 'acc.db'));
mpDb.pragma('journal_mode = WAL');
mpDb.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS manpower_audit (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             at TEXT, actor TEXT, ip TEXT, action TEXT, before TEXT, after TEXT
           );`);
const _mpAudit = mpDb.prepare(`INSERT INTO manpower_audit (at, actor, ip, action, before, after)
                               VALUES (@at, @actor, @ip, @action, @before, @after)`);
const MANPOWER_DEFAULT = {
  today: 148, target: 155, utilisation: 95.5,
  trades: [
    { trade:'Concretor', count:22 }, { trade:'Carpenter', count:18 },
    { trade:'Plasterer', count:18 }, { trade:'Electrician', count:14 },
    { trade:'Plumber', count:12 }, { trade:'Tiler', count:10 }, { trade:'Others', count:54 },
  ],
};
const _mpGet = mpDb.prepare("SELECT value FROM kv WHERE key = 'manpower'");
const _mpPut = mpDb.prepare("INSERT INTO kv (key, value) VALUES ('manpower', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
function getManpower() {
  const r = _mpGet.get();
  if (r) return JSON.parse(r.value);
  _mpPut.run(JSON.stringify(MANPOWER_DEFAULT));
  return MANPOWER_DEFAULT;
}

// ── IDD store (SQLite WAL — see idd_store.js) ────────────────────────────────
const store = createStore(DB_FILE);
const auditMeta = req => ({ actor: req.user?.username || 'unknown', ip: req.ip });
function uid() { return crypto.randomBytes(6).toString('hex'); }

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io — IDD real-time
// ─────────────────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const user = authenticate(socket.handshake.auth?.token);
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  const u = socket.user;
  if (seesAllSites(u.role)) socket.join('hq');
  else if (u.site)          socket.join(`site:${u.site}`);
  log.info('ws-connect', { id: socket.id, user: u.username, total: io.engine.clientsCount });

  const reAuthTimer = setInterval(() => {
    const fresh = authenticate(socket.handshake.auth?.token);
    if (!fresh || fresh.role !== u.role || fresh.site !== (u.site ?? null)) {
      const reason = fresh ? 'Role or site changed — please reload' : 'Session expired or account removed';
      socket.emit('reauth_required', { reason });
      socket.disconnect(true);
    }
  }, 2 * 60 * 1000);

  socket.on('disconnect', () => {
    clearInterval(reAuthTimer);
    log.info('ws-disconnect', { id: socket.id, total: io.engine.clientsCount });
  });
});

function broadcast(event, payload)             { io.emit(event, payload); }
function broadcastSite(site, event, payload)   { io.to(`site:${site}`).to('hq').emit(event, payload); }

// ─────────────────────────────────────────────────────────────────────────────
// IDD seed data
// ─────────────────────────────────────────────────────────────────────────────
const ELEMENT_TYPES = ['Wall Panel','Precast Beam','Precast Column','Precast Slab','PPVC Module'];
const STATUSES      = ['not_started','in_production','pending_qc','qc_passed','ncr_open','ready_delivery','delivered'];
const LEVELS        = ['L01','L02','L03','L04','L05','L06','L07','L08'];
const SITES = [
  { id:'SBW-N4',  name:'Sembawang N4 C16',    blocks:['Blk 301A','Blk 301B','Blk 302'] },
  { id:'TPN-GV',  name:'Tampines GreenVerge', blocks:['Blk 501A','Blk 501B'] },
  { id:'JRW-N2',  name:'Jurong West N2',      blocks:['Blk 712','Blk 713'] },
  { id:'PSR-C38', name:'Pasir Ris C38',       blocks:['Blk 220A'] },
];
const CHECKLIST_TEMPLATE = [
  { code:'DIM', description:'Dimensions within tolerance (±5mm)' },
  { code:'REI', description:'Reinforcement cover meets design requirement' },
  { code:'EMB', description:'Embedded items (inserts, sleeves) correctly placed' },
  { code:'SUR', description:'Surface finish free of honeycombing / cold joints' },
  { code:'CUR', description:'Curing completed — min 7 days or cube test passed' },
  { code:'MRK', description:'Element ID and casting date marked on element' },
  { code:'TAG', description:'QR/RFID tag affixed and scannable' },
  { code:'DOC', description:'Casting record and mix design documented in DCP' },
];
function makeChecklist() {
  return CHECKLIST_TEMPLATE.map(t => ({
    ...t, id:uid(), result:null, remarks:'', checkedBy:null, checkedAt:null, photoUrl:null,
  }));
}
function seedDB(auditEntry) {
  const now = new Date();
  const elements = [];
  let seq = 1;
  const statusDist = [
    { status:'delivered',   weight:10 }, { status:'ready_delivery', weight:8  },
    { status:'qc_passed',   weight:12 }, { status:'ncr_open',       weight:4  },
    { status:'pending_qc',  weight:7  }, { status:'in_production',  weight:6  },
    { status:'not_started', weight:3  },
  ];
  const pool = statusDist.flatMap(d => Array(d.weight).fill(d.status));

  for (const site of SITES) {
   for (const block of site.blocks) {
    for (const level of LEVELS.slice(0, 5)) {
      for (let p = 1; p <= 4; p++) {
        const type     = ELEMENT_TYPES[seq % ELEMENT_TYPES.length];
        const typeCode = type.split(' ').map(w => w[0]).join('');
        const elemId   = `${site.id}-${block.replace('Blk ','B')}-${level}-${typeCode}-${String(p).padStart(3,'0')}`;
        const status   = pool[seq % pool.length];
        const daysAgo  = Math.floor(Math.random() * 30);
        const planned  = new Date(now); planned.setDate(planned.getDate() - daysAgo + 5);
        const actual   = ['qc_passed','ncr_open','ready_delivery','delivered'].includes(status)
          ? new Date(now.getTime() - daysAgo * 86400000) : null;
        const checklist = makeChecklist();
        if (['qc_passed','ncr_open','ready_delivery','delivered'].includes(status)) {
          checklist.forEach(item => {
            item.result    = (status === 'ncr_open' && item.code === 'SUR') ? 'fail' : 'pass';
            item.checkedBy = 'QC Inspector A';
            item.checkedAt = (actual || now).toISOString();
          });
        }
        const ncrs = [];
        if (status === 'ncr_open') {
          ncrs.push({
            id: uid(), elementId: elemId,
            ncrNo: `NCR-${now.getFullYear()}-${String(seq).padStart(4,'0')}`,
            description: 'Surface honeycombing observed on north face, area ~150cm². Exceeds allowable limit per SS EN 1992.',
            severity: 'major', location: 'North face, 1.2m from base',
            raisedBy: 'QC Inspector A', raisedAt: (actual || now).toISOString(),
            status: 'open', correctiveAction: '', closedBy: null, closedAt: null, photos: [],
          });
        }
        elements.push({
          id: elemId, seq, site: site.id, siteName: site.name, type, block, level,
          position: `P${String(p).padStart(2,'0')}`,
          batch: `BATCH-${block.replace('Blk ','').replace(' ','')}-W${String(Math.ceil(seq/8)).padStart(2,'0')}`,
          status,
          plannedDate: planned.toISOString().split('T')[0],
          actualProductionDate: actual ? actual.toISOString().split('T')[0] : null,
          castingDate: ['qc_passed','ncr_open','ready_delivery','delivered'].includes(status)
            ? actual?.toISOString().split('T')[0] : null,
          weight: `${(2.5 + Math.random() * 5).toFixed(1)} t`,
          volume: `${(0.8 + Math.random() * 2).toFixed(2)} m³`,
          concreteGrade: 'C40/50', supplier: 'Kay Lim Precast Factory',
          checklist, ncrs,
          statusHistory: [
            { from:null, to:'not_started', by:'System',
              at: new Date(now.getTime() - (daysAgo + 10) * 86400000).toISOString() },
          ],
          createdAt: new Date(now.getTime() - (daysAgo + 12) * 86400000).toISOString(),
          updatedAt: now.toISOString(),
        });
        seq++;
      }
    }
   }
  }
  const ncrCount = elements.reduce((n, e) => n + e.ncrs.length, 0);
  const weeklyPlanned = Array.from({ length:6 }, () => 8 + Math.floor(Math.random() * 4));
  store.seed(elements, weeklyPlanned, auditEntry);
  log.info('seed', { elements: elements.length, ncrs: ncrCount });
}

if (store.migrateLegacyBlob()) log.info('db', { msg: 'migrated legacy blob → relational tables' });
else if (store.isEmpty()) seedDB();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function fetchT(url, opts = {}, ms = 15000, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    let res;
    try { res = await fetch(url, { ...opts, signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if (res.status !== 429 || attempt >= retries) return res;
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const waitMs = Math.min((Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 1000 * 2 ** attempt), 10000);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function mock(data, integrationError) {
  return integrationError
    ? { ...data, _source: 'mock', _integrationError: integrationError }
    : { ...data, _source: 'mock' };
}

async function liveOrMock(res, label, configured, fetchLive, mockData) {
  if (!configured) {
    if (STRICT_INTEGRATIONS)
      return res.status(502).json({ error: 'integration not configured', source: label, _source: 'error' });
    return res.json(mock(mockData));
  }
  try {
    return res.json({ ...(await fetchLive()), _source: 'live' });
  } catch (e) {
    log.warn('live-call', { label, error: e.message });
    if (STRICT_INTEGRATIONS)
      return res.status(502).json({ error: 'integration unavailable', source: label, detail: e.message, _source: 'error' });
    return res.json(mock(mockData, e.message));
  }
}

function isPlaceholder(v) {
  return typeof v === 'string' &&
    (/^(your_|ask_|change|placeholder|example|<)/i.test(v.trim()) || /_here$/i.test(v.trim()) || v.trim() === '');
}
function real(v) { return (typeof v === 'string' && v.trim() && !isPlaceholder(v)) ? v.trim() : undefined; }
function configured(...names) { return names.every(n => real(process.env[n])); }

function warnPlaceholderCreds() {
  const creds = ['APS_CLIENT_ID','APS_CLIENT_SECRET','PBI_TENANT_ID','PBI_CLIENT_ID',
    'PBI_CLIENT_SECRET','PBI_WORKSPACE_ID','PBI_REPORT_ID','QSE_API_KEY','UNICON_API_KEY','UNICON_COMPANY_ID'];
  const bad = creds.filter(n => process.env[n] && isPlaceholder(process.env[n]));
  if (bad.length) {
    console.warn(`  ⚠ Placeholder values detected (treated as UNCONFIGURED): ${bad.join(', ')}`);
    console.warn('    Replace them with real credentials in .env, or remove them.');
  }
}

/** Coerce v to a non-empty trimmed string ≤ maxLen chars, or return null. */
function str(v, maxLen = 2000) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= maxLen ? s : null;
}

// Site scoping helpers (IDD)
function readSite(req) {
  if (seesAllSites(req.user.role)) return req.query.site || null;
  return req.user.site || '__none__';
}
function canAccessSite(req, site) {
  return seesAllSites(req.user.role) || req.user.site === site;
}

// ─────────────────────────────────────────────────────────────────────────────
// APS / ACC OAuth
// ─────────────────────────────────────────────────────────────────────────────
const APS_BASE    = 'https://developer.api.autodesk.com';
const ACC_ACCOUNT = process.env.ACC_ACCOUNT_ID || 'your_acc_account_id';
const ACC_PROJECT = process.env.ACC_PROJECT_ID || 'your_acc_project_id';

async function oauthToken(cache, url, params, name) {
  if (cache.token && Date.now() < cache.expiry - 30_000) return cache.token;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`${name} auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cache.token  = data.access_token;
  cache.expiry = Date.now() + data.expires_in * 1000;
  return cache.token;
}

const _apsCache = { token: null, expiry: 0 };
const apsConfigured = () => !!(process.env.APS_CLIENT_ID && process.env.APS_CLIENT_SECRET);
async function getApsToken() {
  const id  = process.env.APS_CLIENT_ID;
  const sec = process.env.APS_CLIENT_SECRET;
  if (!id || !sec) throw new Error('APS_CLIENT_ID / APS_CLIENT_SECRET not set in .env');
  return oauthToken(_apsCache, `${APS_BASE}/authentication/v2/token`, new URLSearchParams({
    grant_type: 'client_credentials', client_id: id, client_secret: sec, scope: 'data:read',
  }), 'APS');
}

const _pbiCache = { token: null, expiry: 0 };
async function getPbiToken() {
  const tid = process.env.PBI_TENANT_ID;
  const cid = process.env.PBI_CLIENT_ID;
  const sec = process.env.PBI_CLIENT_SECRET;
  if (!tid || !cid || !sec) throw new Error('PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET not set in .env');
  return oauthToken(_pbiCache, `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, new URLSearchParams({
    grant_type: 'client_credentials', client_id: cid, client_secret: sec,
    scope: 'https://analysis.windows.net/powerbi/api/.default',
  }), 'PBI');
}

// ─────────────────────────────────────────────────────────────────────────────
// UniCon DB helpers
// ─────────────────────────────────────────────────────────────────────────────
const _ucTaskCount = ucDb.prepare(`SELECT project_id, COUNT(*) AS total,
  SUM(status='completed') AS done FROM uc_tasks GROUP BY project_id`);
function ucProjectsWithTasks() {
  const counts = Object.fromEntries(_ucTaskCount.all().map(r => [r.project_id, r]));
  return ucDb.prepare('SELECT * FROM uc_projects ORDER BY created_at').all().map(p => ({
    ...p, tasks: { done: counts[p.id]?.done || 0, total: counts[p.id]?.total || 0 },
  }));
}
function ucTasksWithProject() {
  return ucDb.prepare(`SELECT t.*, p.name AS project FROM uc_tasks t
    LEFT JOIN uc_projects p ON p.id=t.project_id ORDER BY t.created_at`).all();
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Health — covers all three DBs
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const usersPath   = path.join(process.env.DATA_DIR || __dirname, 'users.json');
  const identityOk  = existsSync(usersPath) || !!process.env.ADMIN_PASSWORD;
  const iddOk  = store.ping();
  let ucOk = false, mpOk = false;
  try { ucOk = !!ucDb.prepare('SELECT 1').get(); } catch {}
  try { mpOk = !!mpDb.prepare('SELECT 1').get(); } catch {}
  const ok = identityOk && iddOk && ucOk && mpOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    ts: new Date().toISOString(), service: 'app', uptime: process.uptime(),
    checks: { identity: identityOk, idd: iddOk, uc: ucOk, manpower: mpOk },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration status
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/integrations/status', (_req, res) => {
  res.json({
    acc:    { configured: configured('APS_CLIENT_ID','APS_CLIENT_SECRET'), label: 'Autodesk Construction Cloud' },
    pbi:    { configured: configured('PBI_TENANT_ID','PBI_CLIENT_ID','PBI_CLIENT_SECRET'), label: 'Power BI Embedded' },
    qse:    { configured: configured('QSE_API_KEY'),    label: 'Insight QSE (CAPPS)' },
    unicon: { configured: configured('UNICON_API_KEY'), label: 'UniCon' },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Issues (RFIs + Defects)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/rfis', (_req, res) => liveOrMock(res, 'rfis', apsConfigured(),
  async () => {
    const token = await getApsToken();
    const url   = `${APS_BASE}/construction/issues/v1/projects/${ACC_PROJECT}/issues?limit=100&sortBy=-createdAt`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC issues ${r.status}`);
    const data  = await r.json();
    const results = (data.results || []).map(i => ({
      id:         i.displayId || i.id,
      subject:    i.title || '(No title)',
      status:     i.status,
      discipline: i.issueSubtypeId || '—',
      assignedTo: i.assignedToName || i.assignedTo || '—',
      dueDate:    i.dueDate ? i.dueDate.split('T')[0] : '—',
      agedays:    i.createdAt ? Math.floor((Date.now() - new Date(i.createdAt)) / 86400000) : 0,
      location:   i.locationDescription || '—',
    }));
    return { results, pagination: data.pagination };
  },
  {
    results: [
      { id:'RFI-001', subject:'Column grid offset @ L3 Structural',     discipline:'Structural',    assignedTo:'Tan Wei Ming', status:'open',    dueDate:'2026-06-15', agedays:8  },
      { id:'RFI-002', subject:'M&E duct routing conflict — B1 carpark', discipline:'M&E',           assignedTo:'Lim Ah Kow',   status:'open',    dueDate:'2026-06-12', agedays:5  },
      { id:'RFI-003', subject:'Curtain wall fin alignment L12',          discipline:'Architectural', assignedTo:'Sarah Ng',     status:'closed',  dueDate:'2026-05-30', agedays:22 },
      { id:'RFI-004', subject:'Rebar spacing — transfer slab',           discipline:'Structural',    assignedTo:'Ahmad Fauzi',  status:'overdue', dueDate:'2026-06-01', agedays:30 },
      { id:'RFI-005', subject:'Drainage invert level @ carpark L1',      discipline:'Civil',         assignedTo:'Chan Beng Hwa',status:'open',    dueDate:'2026-06-18', agedays:3  },
      { id:'RFI-006', subject:'Fire-rated door supplier change',          discipline:'Architectural', assignedTo:'Sarah Ng',     status:'closed',  dueDate:'2026-05-25', agedays:27 },
      { id:'RFI-007', subject:'Roof waterproofing membrane spec',         discipline:'Architectural', assignedTo:'Tan Wei Ming', status:'open',    dueDate:'2026-06-20', agedays:1  },
      { id:'RFI-008', subject:'Generator room ventilation top-up',        discipline:'M&E',           assignedTo:'Lim Ah Kow',   status:'overdue', dueDate:'2026-06-03', agedays:28 },
    ],
  }));

app.get('/api/defects', (_req, res) => liveOrMock(res, 'defects', apsConfigured(),
  async () => {
    const token = await getApsToken();
    const url   = `${APS_BASE}/construction/issues/v1/projects/${ACC_PROJECT}/issues?limit=50&filter[status]=open`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC defects ${r.status}`);
    const data  = await r.json();
    const results = (data.results || []).map(i => ({
      id:       i.displayId || i.id,
      title:    i.title,
      status:   i.status,
      severity: i.priority || 'minor',
      location: i.locationDescription || '—',
    }));
    return { results };
  },
  {
    results: [
      { id:'DEF-001', title:'Hollow tile @ L5 toilet',        status:'open',   severity:'major',    location:'L5 Unit 5A'   },
      { id:'DEF-002', title:'Hairline crack wall finishes L6', status:'open',   severity:'minor',    location:'L6 Corridor'  },
      { id:'DEF-003', title:'Exposed rebar @ roof slab',       status:'open',   severity:'critical', location:'Roof Level'   },
      { id:'DEF-004', title:'Water seepage basement carpark',  status:'open',   severity:'major',    location:'B1 Carpark'   },
      { id:'DEF-005', title:'Misaligned door frame L7-02',     status:'open',   severity:'minor',    location:'L7 Unit 7-02' },
      { id:'DEF-006', title:'Defective ACMV grille L4',        status:'closed', severity:'minor',    location:'L4 Corridor'  },
    ],
  }));

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Quality Checklists
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/qaqc', (_req, res) => liveOrMock(res, 'qaqc', apsConfigured(),
  async () => {
    const token = await getApsToken();
    const url   = `${APS_BASE}/quality/v1/projects/${ACC_PROJECT}/checklistInstances?limit=50`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC checklists ${r.status}`);
    const data  = await r.json();
    const results = (data.results || []).map(c => ({
      id:         c.id,
      name:       c.name || c.templateName,
      type:       c.type || c.categoryName || 'General',
      status:     c.status,
      passRate:   c.conformingCount && c.totalCount
                    ? Math.round((c.conformingCount / c.totalCount) * 100) : null,
      location:   c.locationDescription || '—',
      dueDate:    c.dueDate ? c.dueDate.split('T')[0] : '—',
      assignedTo: c.assignedTo || '—',
    }));
    return { results };
  },
  {
    results: [
      { id:'CL-001', name:'Pre-Pour Checklist L5 Slab',    type:'Structural', status:'completed', passRate:95, location:'L5', dueDate:'2026-06-08', assignedTo:'Ahmad Fauzi'  },
      { id:'CL-002', name:'M&E Rough-In 1st Fix L4',        type:'M&E',        status:'active',    passRate:80, location:'L4', dueDate:'2026-06-14', assignedTo:'Lim Ah Kow'   },
      { id:'CL-003', name:'Arch Finishes L6',                type:'Arch Finish',status:'active',    passRate:88, location:'L6', dueDate:'2026-06-16', assignedTo:'Sarah Ng'     },
      { id:'CL-004', name:'Pre-Handover Inspection Unit 3A', type:'Pre-HO',     status:'overdue',   passRate:75, location:'L3', dueDate:'2026-06-05', assignedTo:'Tan Wei Ming' },
      { id:'CL-005', name:'Fire-Stop Checklist B1',          type:'Fire Stop',  status:'completed', passRate:90, location:'B1', dueDate:'2026-06-07', assignedTo:'Chan Beng Hwa'},
    ],
  }));

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Progress (mock)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/progress', (_req, res) => {
  res.json(mock({
    overall: 67, plannedToDate: 72,
    categories: [
      { name:'Structural Works',    planned:80, actual:75 },
      { name:'M&E 1st Fix',         planned:65, actual:60 },
      { name:'Architectural Works', planned:50, actual:42 },
      { name:'Drainage & External', planned:90, actual:88 },
      { name:'Landscaping',         planned:20, actual:10 },
    ],
    weekly: [
      { week:'W1', planned:15, actual:14 },{ week:'W2', planned:25, actual:24 },
      { week:'W3', planned:35, actual:34 },{ week:'W4', planned:48, actual:47 },
      { week:'W5', planned:60, actual:59 },{ week:'W6', planned:72, actual:67 },
    ],
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Manpower
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/manpower', (_req, res) => res.json({ ...getManpower(), _source: 'managed' }));
app.put('/api/manpower', requireFeatureAdmin('manpower'), manpowerLimiter, (req, res) => {
  const cur = getManpower();
  const b = req.body || {};
  const next = { ...cur };
  if (Number.isFinite(b.today))  next.today  = b.today;
  if (Number.isFinite(b.target)) next.target = b.target;
  if (Array.isArray(b.trades)) {
    next.trades = b.trades
      .filter(t => t && typeof t.trade === 'string' && Number.isFinite(t.count))
      .map(t => ({ trade: t.trade.slice(0, 50), count: t.count }));
  }
  next.utilisation = next.target ? Math.round((next.today / next.target) * 1000) / 10 : 0;
  mpDb.transaction(() => {
    _mpPut.run(JSON.stringify(next));
    _mpAudit.run({ at: new Date().toISOString(), actor: req.user.username, ip: req.ip,
      action: 'manpower.update', before: JSON.stringify(cur), after: JSON.stringify(next) });
  })();
  res.json({ ok: true, manpower: { ...next, _source: 'managed' } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Insight QSE (CAPPS)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/qse/inspections', (_req, res) => liveOrMock(res, 'qse/inspections',
  process.env.QSE_BASE_URL && process.env.QSE_API_KEY,
  async () => {
    const r = await fetchT(`${process.env.QSE_BASE_URL}/api/v1/inspections`,
      { headers: { Authorization: `Bearer ${process.env.QSE_API_KEY}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QSE ${r.status}`);
    return r.json();
  },
  { results: [
      { id:'QI-001', type:'Pre-Pour Concrete',     location:'L5 Grid C-D/3-4', inspector:'Ahmad Fauzi',  defects:0, status:'closed', date:'2026-06-08' },
      { id:'QI-002', type:'M&E Rough-In 1st Fix',   location:'L4 Zone B',       inspector:'Lim Ah Kow',   defects:3, status:'open',   date:'2026-06-09' },
      { id:'QI-003', type:'Architectural Finishes', location:'L6 Unit 6B',      inspector:'Sarah Ng',     defects:1, status:'open',   date:'2026-06-09' },
      { id:'QI-004', type:'Pre-Handover',            location:'L3 Unit 3A',      inspector:'Tan Wei Ming', defects:5, status:'open',   date:'2026-06-07' },
      { id:'QI-005', type:'Structural M&E',          location:'B1 Risers',       inspector:'Chan Beng Hwa',defects:0, status:'closed', date:'2026-06-06' },
    ] }));

app.get('/api/qse/safety', (_req, res) => liveOrMock(res, 'qse/safety',
  process.env.QSE_BASE_URL && process.env.QSE_API_KEY,
  async () => {
    const r = await fetchT(`${process.env.QSE_BASE_URL}/api/v1/safety/inspections`,
      { headers: { Authorization: `Bearer ${process.env.QSE_API_KEY}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QSE Safety ${r.status}`);
    return r.json();
  },
  {
    open: 8, closed: 44, thisWeek: 3,
    categories: [
      { name:'PPE', count:6 },{ name:'Housekeeping', count:8 },
      { name:'Scaffolding', count:4 },{ name:'Fire Safety', count:2 },{ name:'Other', count:2 },
    ],
    trend: [
      { month:'Jan',raised:8,closed:7 },{ month:'Feb',raised:12,closed:11 },
      { month:'Mar',raised:7,closed:7 },{ month:'Apr',raised:10,closed:9 },
      { month:'May',raised:9,closed:9 },{ month:'Jun',raised:6,closed:4 },
    ],
    inspections: [
      { date:'2026-06-09', type:'Daily',  inspector:'Wong Kai Feng', infringements:2, status:'open'   },
      { date:'2026-06-09', type:'Random', inspector:'Rajan Kumar',   infringements:0, status:'closed' },
      { date:'2026-06-08', type:'Daily',  inspector:'Wong Kai Feng', infringements:1, status:'closed' },
    ],
  }));

app.get('/api/qse/ptw', (_req, res) => liveOrMock(res, 'qse/ptw',
  process.env.QSE_BASE_URL && process.env.QSE_API_KEY,
  async () => {
    const r = await fetchT(`${process.env.QSE_BASE_URL}/api/v1/ptw/permits`,
      { headers: { Authorization: `Bearer ${process.env.QSE_API_KEY}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QSE PTW ${r.status}`);
    return r.json();
  },
  { results: [
      { id:'PTW-001', work:'Hot Work — Welding',    location:'L5 Structural Frame', issuer:'Ahmad Fauzi',   expiry:'2026-06-09 17:00', status:'active'   },
      { id:'PTW-002', work:'Confined Space Entry',  location:'Underground Sump',    issuer:'Rajan Kumar',   expiry:'2026-06-09 16:00', status:'expiring' },
      { id:'PTW-003', work:'Working at Height >3m', location:'L8 Roof Form',        issuer:'Chan Beng Hwa', expiry:'2026-06-09 18:00', status:'active'   },
      { id:'PTW-004', work:'Electrical Isolation',  location:'MSB Room B1',         issuer:'Lim Ah Kow',    expiry:'2026-06-10 08:00', status:'active'   },
      { id:'PTW-005', work:'Hot Work — Cutting',    location:'L6 Architectural',    issuer:'Ahmad Fauzi',   expiry:'2026-06-08 17:00', status:'expired'  },
    ] }));

app.get('/api/qse/attendance', (_req, res) => liveOrMock(res, 'qse/attendance',
  process.env.QSE_BASE_URL && process.env.QSE_API_KEY,
  async () => {
    const r = await fetchT(`${process.env.QSE_BASE_URL}/api/v1/attendance/workers`,
      { headers: { Authorization: `Bearer ${process.env.QSE_API_KEY}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`QSE Attendance ${r.status}`);
    return r.json();
  },
  {
    todayTotal: 148, expected: 155,
    trades: [
      { trade:'Concretor',  count:22 },{ trade:'Carpenter',  count:18 },
      { trade:'Plasterer',  count:18 },{ trade:'Electrician',count:14 },
      { trade:'Plumber',    count:12 },{ trade:'Tiler',      count:10 },{ trade:'Others',count:54 },
    ],
    weekly: [
      { day:'Mon',present:145,expected:155 },{ day:'Tue',present:150,expected:155 },
      { day:'Wed',present:155,expected:155 },{ day:'Thu',present:148,expected:155 },
      { day:'Fri',present:148,expected:155 },
    ],
  }));

// ─────────────────────────────────────────────────────────────────────────────
// UniCon — Projects
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/unicon/projects', requireAuth, (_req, res) => res.json({ results: ucProjectsWithTasks() }));
app.get('/api/uc/projects',     requireAuth, (_req, res) => res.json({ projects: ucProjectsWithTasks() }));
app.post('/api/uc/projects', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  const errors = validateUcProject(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const { name, status='active', progress=0, budget_sgd=0, spent_sgd=0, due_date=null } = req.body;
  const id = ucId();
  ucDb.transaction(() => {
    ucDb.prepare('INSERT INTO uc_projects (id,name,status,progress,budget_sgd,spent_sgd,due_date) VALUES (?,?,?,?,?,?,?)')
      .run(id, name.trim(), status, Number(progress)||0, Number(budget_sgd)||0, Number(spent_sgd)||0, due_date||null);
    ucAudit(req, 'project.create', id, { name: name.trim(), status });
  })();
  res.status(201).json(ucDb.prepare('SELECT * FROM uc_projects WHERE id=?').get(id));
});
app.put('/api/uc/projects/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  if (!ucDb.prepare('SELECT id FROM uc_projects WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'not found' });
  const { name, status, progress, budget_sgd, spent_sgd, due_date } = req.body || {};
  const errors = validateUcProject({ name: name || 'placeholder', status, progress, budget_sgd, spent_sgd, due_date });
  const fieldErrors = errors.filter(e => e !== 'name required');
  if (fieldErrors.length) return res.status(400).json({ errors: fieldErrors });
  ucDb.transaction(() => {
    ucDb.prepare(`UPDATE uc_projects SET
      name=COALESCE(?,name), status=COALESCE(?,status), progress=COALESCE(?,progress),
      budget_sgd=COALESCE(?,budget_sgd), spent_sgd=COALESCE(?,spent_sgd), due_date=COALESCE(?,due_date)
      WHERE id=?`).run(name||null, status||null, progress??null, budget_sgd??null, spent_sgd??null, due_date||null, req.params.id);
    ucAudit(req, 'project.update', req.params.id);
  })();
  res.json(ucDb.prepare('SELECT * FROM uc_projects WHERE id=?').get(req.params.id));
});
app.delete('/api/uc/projects/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  let changes = 0;
  ucDb.transaction(() => {
    ucDb.prepare('DELETE FROM uc_tasks WHERE project_id=?').run(req.params.id);
    changes = ucDb.prepare('DELETE FROM uc_projects WHERE id=?').run(req.params.id).changes;
    if (changes) ucAudit(req, 'project.delete', req.params.id);
  })();
  if (!changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// UniCon — Tasks
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/unicon/tasks', requireAuth, (_req, res) => {
  const tasks = ucTasksWithProject();
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    open: tasks.filter(t => t.status === 'open').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    overdue: tasks.filter(t => t.status === 'overdue').length,
    dueToday: tasks.filter(t => t.due_date === today && t.status !== 'completed').length,
    tasks,
  });
});
app.get('/api/uc/tasks', requireAuth, (_req, res) => res.json({ tasks: ucTasksWithProject() }));
app.post('/api/uc/tasks', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  const errors = validateUcTask(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const { project_id, title, assigned_to='', priority='med', due_date=null, status='open' } = req.body;
  if (!ucDb.prepare('SELECT id FROM uc_projects WHERE id=?').get(project_id))
    return res.status(400).json({ errors: ['valid project_id required'] });
  const id = ucId();
  ucDb.transaction(() => {
    ucDb.prepare('INSERT INTO uc_tasks (id,project_id,title,assigned_to,priority,due_date,status) VALUES (?,?,?,?,?,?,?)')
      .run(id, project_id, title.trim(), assigned_to, priority, due_date||null, status);
    ucAudit(req, 'task.create', id, { project_id, title: title.trim() });
  })();
  res.status(201).json(ucDb.prepare('SELECT * FROM uc_tasks WHERE id=?').get(id));
});
app.put('/api/uc/tasks/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  if (!ucDb.prepare('SELECT id FROM uc_tasks WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'not found' });
  const { title, project_id, assigned_to, priority, due_date, status } = req.body || {};
  const errors = validateUcTask({ title: title || 'placeholder', project_id: project_id || 'placeholder', priority, status, due_date });
  const fieldErrors = errors.filter(e => e !== 'title required' && e !== 'project_id required');
  if (fieldErrors.length) return res.status(400).json({ errors: fieldErrors });
  ucDb.transaction(() => {
    ucDb.prepare(`UPDATE uc_tasks SET
      title=COALESCE(?,title), project_id=COALESCE(?,project_id), assigned_to=COALESCE(?,assigned_to),
      priority=COALESCE(?,priority), due_date=COALESCE(?,due_date), status=COALESCE(?,status)
      WHERE id=?`).run(title||null, project_id||null, assigned_to||null, priority||null, due_date||null, status||null, req.params.id);
    ucAudit(req, 'task.update', req.params.id);
  })();
  res.json(ucDb.prepare('SELECT * FROM uc_tasks WHERE id=?').get(req.params.id));
});
app.delete('/api/uc/tasks/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  let changes = 0;
  ucDb.transaction(() => {
    changes = ucDb.prepare('DELETE FROM uc_tasks WHERE id=?').run(req.params.id).changes;
    if (changes) ucAudit(req, 'task.delete', req.params.id);
  })();
  if (!changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// UniCon — Budget, Members, Subcontractors
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/unicon/budget', requireAuth, (_req, res) => {
  const projects = ucDb.prepare('SELECT * FROM uc_projects ORDER BY created_at').all();
  const totalContract = projects.reduce((s, p) => s + p.budget_sgd, 0);
  const totalBilled   = projects.reduce((s, p) => s + p.spent_sgd, 0);
  res.json({
    totalContract, totalBilled, forecast: totalContract,
    projects: projects.map(p => ({
      name: p.name, contract: p.budget_sgd, billed: p.spent_sgd,
      utilPct: p.budget_sgd > 0 ? Math.round(p.spent_sgd / p.budget_sgd * 100) : 0,
    })),
  });
});

app.get('/api/uc/members', requireAuth, (_req, res) =>
  res.json({ members: ucDb.prepare('SELECT * FROM uc_members ORDER BY created_at').all() }));
app.post('/api/uc/members', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  const { name, role='' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ errors: ['name required'] });
  const id = ucId();
  ucDb.transaction(() => {
    ucDb.prepare('INSERT INTO uc_members (id,name,role) VALUES (?,?,?)').run(id, name.trim(), role);
    ucAudit(req, 'member.create', id, { name: name.trim() });
  })();
  res.status(201).json(ucDb.prepare('SELECT * FROM uc_members WHERE id=?').get(id));
});
app.put('/api/uc/members/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  if (!ucDb.prepare('SELECT id FROM uc_members WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'not found' });
  const { name, role } = req.body || {};
  ucDb.transaction(() => {
    ucDb.prepare('UPDATE uc_members SET name=COALESCE(?,name), role=COALESCE(?,role) WHERE id=?')
      .run(name||null, role||null, req.params.id);
    ucAudit(req, 'member.update', req.params.id);
  })();
  res.json(ucDb.prepare('SELECT * FROM uc_members WHERE id=?').get(req.params.id));
});
app.delete('/api/uc/members/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  let changes = 0;
  ucDb.transaction(() => {
    changes = ucDb.prepare('DELETE FROM uc_members WHERE id=?').run(req.params.id).changes;
    if (changes) ucAudit(req, 'member.delete', req.params.id);
  })();
  if (!changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/uc/subcontractors', requireAuth, (_req, res) =>
  res.json({ subcontractors: ucDb.prepare('SELECT * FROM uc_subcontractors ORDER BY created_at').all() }));
app.post('/api/uc/subcontractors', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  const { company, trade='', status='active', workers=0 } = req.body || {};
  if (!company?.trim()) return res.status(400).json({ errors: ['company required'] });
  if (status != null && !UC_SUB_STATUSES.has(status))
    return res.status(400).json({ errors: [`status must be one of: ${[...UC_SUB_STATUSES].join(', ')}`] });
  if (Number(workers) < 0) return res.status(400).json({ errors: ['workers must be ≥ 0'] });
  const id = ucId();
  ucDb.transaction(() => {
    ucDb.prepare('INSERT INTO uc_subcontractors (id,company,trade,status,workers) VALUES (?,?,?,?,?)')
      .run(id, company.trim(), trade, status, Number(workers)||0);
    ucAudit(req, 'subcontractor.create', id, { company: company.trim() });
  })();
  res.status(201).json(ucDb.prepare('SELECT * FROM uc_subcontractors WHERE id=?').get(id));
});
app.put('/api/uc/subcontractors/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  if (!ucDb.prepare('SELECT id FROM uc_subcontractors WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'not found' });
  const { company, trade, status, workers } = req.body || {};
  if (status != null && !UC_SUB_STATUSES.has(status))
    return res.status(400).json({ errors: [`status must be one of: ${[...UC_SUB_STATUSES].join(', ')}`] });
  if (workers != null && Number(workers) < 0) return res.status(400).json({ errors: ['workers must be ≥ 0'] });
  ucDb.transaction(() => {
    ucDb.prepare(`UPDATE uc_subcontractors SET company=COALESCE(?,company), trade=COALESCE(?,trade),
      status=COALESCE(?,status), workers=COALESCE(?,workers) WHERE id=?`)
      .run(company||null, trade||null, status||null, workers??null, req.params.id);
    ucAudit(req, 'subcontractor.update', req.params.id);
  })();
  res.json(ucDb.prepare('SELECT * FROM uc_subcontractors WHERE id=?').get(req.params.id));
});
app.delete('/api/uc/subcontractors/:id', requireAuth, requireUcAdmin, mutationLimiter, (req, res) => {
  let changes = 0;
  ucDb.transaction(() => {
    changes = ucDb.prepare('DELETE FROM uc_subcontractors WHERE id=?').run(req.params.id).changes;
    if (changes) ucAudit(req, 'subcontractor.delete', req.params.id);
  })();
  if (!changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Power BI
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/powerbi-reports', (_req, res) => liveOrMock(res, 'powerbi-reports',
  !!(process.env.PBI_WORKSPACE_ID && process.env.PBI_TENANT_ID && process.env.PBI_CLIENT_ID && process.env.PBI_CLIENT_SECRET),
  async () => {
    const wsId  = process.env.PBI_WORKSPACE_ID;
    const token = await getPbiToken();
    const r = await fetchT(`https://api.powerbi.com/v1.0/myorg/groups/${wsId}/reports`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`PBI reports ${r.status}`);
    const data = await r.json();
    return {
      reports: (data.value || [])
        .filter(rep => PBI_ALLOWED.size === 0 || PBI_ALLOWED.has(rep.id.toLowerCase()))
        .map(rep => ({ id: rep.id, name: rep.name, embedUrl: rep.embedUrl })),
    };
  },
  { reports: [{ id: process.env.PBI_REPORT_ID || 'placeholder', name: 'Kay Lim Construction Dashboard' }] }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get('/api/powerbi-embed', async (req, res) => {
  const wsId  = process.env.PBI_WORKSPACE_ID;
  const repId = req.query.reportId || process.env.PBI_REPORT_ID;
  if (!wsId || !repId)
    return res.json(mock({ note: 'Set PBI_WORKSPACE_ID and PBI_REPORT_ID in .env.' }));
  if (!UUID_RE.test(repId))
    return res.status(400).json({ ok: false, error: 'Invalid report ID format' });
  if (PBI_ALLOWED.size > 0 && !PBI_ALLOWED.has(repId.toLowerCase()))
    return res.status(403).json({ ok: false, error: 'Report not in application allowlist' });
  try {
    const token = await getPbiToken();
    const rptRes = await fetchT(`https://api.powerbi.com/v1.0/myorg/groups/${wsId}/reports/${repId}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!rptRes.ok) throw new Error(`PBI report fetch ${rptRes.status}`);
    const rpt = await rptRes.json();
    const body = {
      datasets: [{ id: rpt.datasetId }], reports: [{ id: repId }],
      identities: [{ username: req.user.username, roles: [req.user.role], datasets: [rpt.datasetId] }],
    };
    const tokenRes = await fetchT('https://api.powerbi.com/v1.0/myorg/GenerateToken', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!tokenRes.ok) throw new Error(`PBI GenerateToken ${tokenRes.status}: ${await tokenRes.text()}`);
    const embedToken = await tokenRes.json();
    res.json({ embedToken: embedToken.token, embedUrl: rpt.embedUrl, reportId: repId,
      expiry: embedToken.expiration, source: 'live' });
  } catch (e) {
    log.warn('powerbi-embed', { error: e.message });
    res.status(500).json({ error: e.message, source: 'error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IDD QWC1 — Digital Production + Logistics (mock; replaced by live /api/production/* when configured)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/idd/production', async (_req, res) => {
  const key = process.env.UNICON_API_KEY;
  if (key) {
    try {
      const base = process.env.UNICON_BASE_URL || 'https://api.unicongroup.co';
      const r = await fetchT(`${base}/api/companies/${process.env.UNICON_COMPANY_ID}/idd/production`,
        { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      if (r.ok) return res.json(await r.json());
    } catch { /* fall through */ }
  }
  res.json({
    _source: 'mock', totalElements: 135, qcPassed: 99, inProduction: 28, openNCRs: 4, batches: 6,
    statusBreakdown: { passed: 99, inProduction: 28, ncr: 4, notStarted: 4 },
    weeklyRate: { labels:['Wk20','Wk21','Wk22','Wk23','Wk24'], planned:[12,14,14,16,14], actual:[11,13,15,14,12] },
    cumulPlan: [10,22,38,55,75,98,115], cumulActual: [9,20,36,53,71,null,null],
    qcPassRates: { types:['PPVC Module','Wall Panel','Staircase','Beam','Column'], rates:[92,100,100,75,95] },
    batchList: [
      { id:'B-001', type:'PPVC Module',       factory:'YTL Precast, JB',      ordered:24, produced:18, qcStatus:'Passed',         targetDelivery:'2026-06-20', status:'In Production' },
      { id:'B-002', type:'Precast Wall Panel', factory:'Straits Precast, SG', ordered:60, produced:60, qcStatus:'Passed',         targetDelivery:'2026-06-15', status:'QC Passed'     },
      { id:'B-003', type:'PPVC Module',       factory:'YTL Precast, JB',      ordered:24, produced: 6, qcStatus:'Pending',        targetDelivery:'2026-07-10', status:'In Production' },
      { id:'B-004', type:'Precast Staircase', factory:'Straits Precast, SG',  ordered:15, produced:15, qcStatus:'Passed',         targetDelivery:'2026-06-12', status:'QC Passed'     },
      { id:'B-005', type:'Precast Beam',      factory:'Straits Precast, SG',  ordered: 8, produced: 4, qcStatus:'Failed - Rework',targetDelivery:'2026-06-25', status:'NCR Raised'    },
      { id:'B-006', type:'PPVC Module',       factory:'YTL Precast, JB',      ordered: 4, produced: 0, qcStatus:'Not Started',    targetDelivery:'2026-07-30', status:'Not Started'   },
    ],
  });
});

app.get('/api/idd/logistics', async (_req, res) => {
  const key = process.env.UNICON_API_KEY;
  if (key) {
    try {
      const base = process.env.UNICON_BASE_URL || 'https://api.unicongroup.co';
      const r = await fetchT(`${base}/api/companies/${process.env.UNICON_COMPANY_ID}/idd/logistics`,
        { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      if (r.ok) return res.json(await r.json());
    } catch { /* fall through */ }
  }
  res.json({
    _source: 'mock', deliveriesToday: 3, completedThisWeek: 18, onTimeRate: 89, pending: 9,
    weeklyPerf: { labels:['Wk20','Wk21','Wk22','Wk23','Wk24'], scheduled:[18,21,19,22,20], received:[17,20,19,21,18] },
    onTimeTrend: [84,88,85,91,89], onTimeTrendLabels: ['Feb','Mar','Apr','May','Jun'],
    categoryBreakdown: [
      { category:'PPVC Module', count:18 },{ category:'Precast Panel', count:24 },
      { category:'Structural Steel', count:15 },{ category:'M&E Equipment', count:22 },
      { category:'Architectural', count:9 },{ category:'Materials', count:12 },
    ],
    deliveries: [
      { doNo:'DO-0042', item:'PPVC Module B-001 Units 1-6',          category:'PPVC Module',      supplier:'YTL Precast',      qty:'6 units',   scheduled:'2026-06-10 07:00', received:null,               craneSlot:'Crane 1 07:00-10:00', status:'scheduled' },
      { doNo:'DO-0041', item:'Rebar Bundle Ref R40-B2',              category:'Structural Steel', supplier:'Compact Metal',    qty:'12 tonnes', scheduled:'2026-06-09 13:00', received:'2026-06-09 13:45', craneSlot:null,                  status:'received'  },
      { doNo:'DO-0040', item:'Precast Wall Panel B-002 Units 55-60', category:'Precast Panel',    supplier:'Straits Precast',  qty:'6 panels',  scheduled:'2026-06-09 08:00', received:'2026-06-09 09:15', craneSlot:'Crane 2 08:00-11:00', status:'received'  },
      { doNo:'DO-0039', item:'Curtain Wall System CW-3',             category:'Architectural',    supplier:'Schindler Facades',qty:'1 lot',     scheduled:'2026-06-08 07:00', received:'2026-06-08 07:30', craneSlot:'Crane 1 07:00-09:00', status:'received'  },
      { doNo:'DO-0038', item:'M&E Chilled Water Pipes Pkg 3',        category:'M&E Equipment',    supplier:'Uni-Air Eng',      qty:'1 lot',     scheduled:'2026-06-07 14:00', received:'2026-06-08 09:00', craneSlot:null,                  status:'late'      },
      { doNo:'DO-0043', item:'Precast Staircase B-004 Units 13-15',  category:'Precast Panel',    supplier:'Straits Precast',  qty:'3 flights', scheduled:'2026-06-11 07:00', received:null,               craneSlot:'Crane 2 07:00-10:00', status:'pending'   },
      { doNo:'DO-0044', item:'Waterproofing Membrane Roof',          category:'Materials',        supplier:'Sika SG',          qty:'500 sqm',   scheduled:'2026-06-12 10:00', received:null,               craneSlot:null,                  status:'pending'   },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IDD Production — element register + QC + NCR (real-time, Socket.io)
// ─────────────────────────────────────────────────────────────────────────────
const VALID_STATUSES   = new Set(['not_started','in_production','pending_qc','qc_passed','ncr_open','ready_delivery','delivered']);
const VALID_SEVERITIES = new Set(['minor','major','critical']);
const VALID_RESULTS    = new Set(['pass','fail','na']);

app.get('/api/production/sites', requireAuth, (req, res) => {
  const all = store.sites();
  res.json(seesAllSites(req.user.role) ? all : all.filter(s => s.site === req.user.site));
});

app.get('/api/production/dashboard', requireAuth, (req, res) => {
  const { statusCounts, typeCounts, total, actualDates, openNCRs, closedNCRs,
          bySite, site, weeklyPlanned, lastUpdated } = store.dashboardRaw(readSite(req));
  const byStatus = {};
  STATUSES.forEach(s => { byStatus[s] = statusCounts[s] || 0; });
  const passed    = (byStatus.qc_passed||0) + (byStatus.ready_delivery||0) + (byStatus.delivered||0);
  const inProd    =  byStatus.in_production || 0;
  const pendingQC =  byStatus.pending_qc    || 0;
  const ncrOpen   =  byStatus.ncr_open      || 0;
  const readyDel  =  byStatus.ready_delivery|| 0;
  const delivered =  byStatus.delivered     || 0;
  const now = new Date();
  const weeks = weeklyPlanned.map((planned, i) => {
    const w = 5 - i;
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - w * 7 - 6);
    const weekEnd   = new Date(now); weekEnd.setDate(weekEnd.getDate()   - w * 7);
    const actual = actualDates.filter(d => { const dt = new Date(d); return dt >= weekStart && dt <= weekEnd; }).length;
    return { label: `W${i + 1}`, planned, actual };
  });
  const cumul = { planned:[], actual:[] };
  let cumPlan = 0, cumActual = 0;
  weeks.forEach(w => { cumPlan += w.planned; cumActual += w.actual; cumul.planned.push(cumPlan); cumul.actual.push(cumActual); });
  res.json({ site, bySite, total, passed, inProd, pendingQC, ncrOpen, readyDel, delivered,
    completionRate: total ? Math.round((passed / total) * 100) : 0,
    byStatus, byType: typeCounts, weeks, cumul, openNCRs, closedNCRs, lastUpdated });
});

app.get('/api/production/elements', requireAuth, (req, res) => {
  const q = { ...req.query };
  const scoped = readSite(req);
  if (!seesAllSites(req.user.role)) q.site = scoped;
  res.json(store.listElements(q));
});

app.get('/api/production/elements/:id', requireAuth, (req, res) => {
  const el = store.getElement(req.params.id);
  if (!el) return res.status(404).json({ error: 'Not found' });
  if (!canAccessSite(req, el.site)) return res.status(403).json({ ok:false, error: 'Forbidden — element belongs to another site' });
  res.json(el);
});

app.patch('/api/production/elements/:id/status', requireRole('inspector'), mutationLimiter, (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.has(status))
    return res.status(400).json({ ok:false, error: 'Invalid status value' });
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error: 'Forbidden — element belongs to another site' });
  const el = store.withElement(req.params.id, (el, ctx) => {
    el.statusHistory.push({ from:el.status, to:status, by:req.user.username, at:new Date().toISOString() });
    el.status = status;
    el.updatedAt = new Date().toISOString();
    if (status === 'in_production') el.actualProductionDate = new Date().toISOString().split('T')[0];
    ctx.audit('element.status', { elementId:el.id, status:el.status });
    return el;
  }, auditMeta(req));
  if (el === store.NOT_FOUND) return res.status(404).json({ error: 'Not found' });
  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, by:req.user.username, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, element:el });
});

app.patch('/api/production/elements/:id/checklist', requireRole('inspector'), mutationLimiter, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error: 'Forbidden — element belongs to another site' });
  const el = store.withElement(req.params.id, (el, ctx) => {
    items.forEach(upd => {
      if (!upd?.id) return;
      const item = el.checklist.find(i => i.id === upd.id);
      if (!item) return;
      if (upd.result !== undefined && VALID_RESULTS.has(upd.result)) item.result = upd.result;
      if (typeof upd.remarks  === 'string') item.remarks  = upd.remarks.slice(0, 1000);
      if (typeof upd.photoUrl === 'string') item.photoUrl = upd.photoUrl.slice(0, 500);
      item.checkedBy = req.user.username;
      item.checkedAt = new Date().toISOString();
    });
    const allChecked = el.checklist.every(i => i.result !== null);
    const anyFail    = el.checklist.some(i => i.result === 'fail');
    if (allChecked) {
      const newStatus = anyFail ? 'ncr_open' : 'qc_passed';
      el.statusHistory.push({ from:el.status, to:newStatus, by:req.user.username, at:new Date().toISOString() });
      el.status = newStatus;
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('element.checklist', { elementId:el.id, status:el.status });
    return el;
  }, auditMeta(req));
  if (el === store.NOT_FOUND) return res.status(404).json({ error: 'Not found' });
  broadcastSite(el.site, 'element:updated', {
    id:el.id, status:el.status, by:req.user.username,
    checklistPct: Math.round(el.checklist.filter(i => i.result !== null).length / el.checklist.length * 100),
    updatedAt: el.updatedAt,
  });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, element:el });
});

app.post('/api/production/elements/:id/ncrs', requireRole('inspector'), mutationLimiter, (req, res) => {
  const description = str(req.body.description, 2000);
  if (!description) return res.status(400).json({ ok:false, error: 'description is required (max 2000 chars)' });
  const severity = VALID_SEVERITIES.has(req.body.severity) ? req.body.severity : 'minor';
  const location = str(req.body.location, 500) || '';
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error: 'Forbidden — element belongs to another site' });
  const out = store.withElement(req.params.id, (el, ctx) => {
    const ncr = {
      id: uid(), elementId:el.id, ncrNo: ctx.nextNcrNo(), description, severity, location,
      raisedBy: req.user.username, raisedAt: new Date().toISOString(),
      status: 'open', correctiveAction:'', closedBy:null, closedAt:null, photos:[],
    };
    el.ncrs.push(ncr);
    if (el.status !== 'ncr_open') {
      el.statusHistory.push({ from:el.status, to:'ncr_open', by:req.user.username, at:new Date().toISOString() });
      el.status = 'ncr_open';
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('ncr.raise', { elementId:el.id, ncrNo:ncr.ncrNo, severity:ncr.severity });
    return { el, ncr };
  }, auditMeta(req));
  if (out === store.NOT_FOUND) return res.status(404).json({ error: 'Not found' });
  const { el, ncr } = out;
  broadcastSite(el.site, 'ncr:raised',      { ncrNo:ncr.ncrNo, elementId:el.id, severity:ncr.severity, raisedBy:ncr.raisedBy });
  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.status(201).json({ ok:true, ncr });
});

app.patch('/api/production/ncrs/:ncrId', requireRole('supervisor'), mutationLimiter, (req, res) => {
  const { status, correctiveAction } = req.body;
  if (status && !['open','in_progress','closed'].includes(status))
    return res.status(400).json({ ok:false, error: 'Invalid NCR status' });
  if (!canAccessSite(req, store.ncrSite(req.params.ncrId)))
    return res.status(403).json({ ok:false, error: 'Forbidden — NCR belongs to another site' });
  const out = store.withNcr(req.params.ncrId, (el, ncr, ctx) => {
    if (status) ncr.status = status;
    if (correctiveAction !== undefined) ncr.correctiveAction = str(correctiveAction, 2000) || ncr.correctiveAction;
    if (status === 'closed') { ncr.closedBy = req.user.username; ncr.closedAt = new Date().toISOString(); }
    if (status === 'closed' && el.ncrs.every(n => n.status === 'closed')) {
      el.statusHistory.push({ from:el.status, to:'pending_qc', by:req.user.username, at:new Date().toISOString() });
      el.status = 'pending_qc';
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('ncr.update', { ncrNo:ncr.ncrNo, status:ncr.status });
    return { el, ncr };
  }, auditMeta(req));
  if (out === store.NOT_FOUND) return res.status(404).json({ error: 'NCR not found' });
  const { el, ncr } = out;
  broadcastSite(el.site, 'ncr:updated',     { id:ncr.id, ncrNo:ncr.ncrNo, status:ncr.status, elementId:ncr.elementId });
  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, ncr });
});

app.get('/api/production/ncrs', requireAuth, (req, res) => {
  const site = seesAllSites(req.user.role) ? req.query.site : (req.user.site || '__none__');
  res.json(store.listNcrs(req.query.status, site));
});

app.post('/api/production/reset', requireAdmin, mutationLimiter, (req, res) => {
  const backup = path.join(process.env.DATA_DIR || __dirname, `idd_data_backup_${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(store.exportAll(), null, 2));
  seedDB({ ...auditMeta(req), action: 'db.reset', details: { backup: path.basename(backup) } });
  broadcast('dashboard:refresh', {});
  res.json({ ok:true, message:'Database reset to seed data', backup: path.basename(backup) });
});

app.get('/api/production/audit/verify', requireAdmin, (_req, res) => res.json(store.verifyAuditChain()));

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info('shutdown', { signal });
  io.close(() => {
    server.close(() => {
      store.close();
      try { ucDb.close(); } catch {}
      try { mpDb.close(); } catch {}
      closeRevokedDb();
      log.info('shutdown', { stage: 'closed' });
      process.exit(0);
    });
  });
  setTimeout(() => { log.warn('shutdown', { stage: 'forced-exit', after: '10s' }); process.exit(1); }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(PORT, () => {
  warnPlaceholderCreds();
  const scheme = tls ? 'https' : 'http';
  console.log(`\n🏗  Kay Lim Unified Server — ${scheme}://localhost:${PORT}`);
  console.log(`   Command Centre : ${scheme}://localhost:${PORT}/`);
  console.log(`   IDD Production : ${scheme}://localhost:${PORT}/idd`);
  console.log(`   WebSocket      : ${tls ? 'wss' : 'ws'}://localhost:${PORT}   (Socket.io)`);
  console.log(`   Auth           : POST /api/login  (node auth.js add-user <name> <password>)`);
  console.log(`   TLS            : ${tls ? '✅ HTTPS enabled' : '⚠ HTTP — terminate TLS at a reverse proxy'}`);
  console.log(`   APS            : ${process.env.APS_CLIENT_ID  ? '✅ set' : '❌ missing — set APS_CLIENT_ID + APS_CLIENT_SECRET in .env'}`);
  console.log(`   Power BI       : ${process.env.PBI_TENANT_ID  ? '✅ set' : '⏳ set PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET / PBI_WORKSPACE_ID'}`);
  console.log(`   Insight QSE    : ${process.env.QSE_API_KEY    ? '✅ set' : '⏳ contact CAPPS (contact@capps.com.sg / +65 6509 0309)'}`);
  const { elements: nEl, ncrs: nNcr } = store.counts();
  console.log(`   IDD records    : ${nEl} elements, ${nNcr} NCRs\n`);
});
