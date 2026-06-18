/**
 * IDD Digital Production Server — REAL-TIME
 * HDB BSS S77 §77.2.3 Use Case #6 — Digital Production Prototype
 *
 * Run:  node idd_production_server.js
 * Port: 3002  (separate from main dashboard on 3001)
 *
 * Storage: ./idd_data.json  (auto-created on first run)
 * Real-time: Socket.io — broadcasts every mutation to all connected clients
 *
 * Install deps (once):
 *   npm install express socket.io express-rate-limit
 *
 * Environment variables (optional):
 *   PORT           – listening port           (default: 3002)
 *   ALLOWED_ORIGIN – CORS allowed origin      (default: http://localhost:<PORT>)
 *   ADMIN_PASSWORD – first-run admin password (see auth.js; random if unset)
 *   SESSION_SECRET – token signing secret     (auto-generated if unset)
 *   TLS_KEY_FILE / TLS_CERT_FILE – serve HTTPS directly (else use a reverse proxy)
 *
 * Auth: per-user login (POST /api/login) → signed 8h session token.
 * Manage users:  node auth.js add-user <name> <password> [admin|user]
 *
 */

import express  from 'express';
import { Server as SocketIO } from 'socket.io';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createStore } from './idd_store.js';
import { requireAuth, requireAdmin, requireRole, loginHandler, logoutHandler, authenticate, seesAllSites, assertSecureConfig, makeServer } from './auth.js';
import { makeLogger } from './logger.js';
import { validateConfig, IDD_SCHEMA } from './config-schema.js';
import { randomUUID } from 'node:crypto';

assertSecureConfig();   // refuse to boot with example/placeholder secrets
const log = makeLogger('idd');
const { errors: cfgErrors, warnings: cfgWarnings } = validateConfig(process.env, IDD_SCHEMA);
cfgWarnings.forEach(w => log.warn('config', { detail: w }));
if (cfgErrors.length) { cfgErrors.forEach(e => log.error('config', { detail: e })); process.exit(1); }

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const PORT           = process.env.PORT           || 3002;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const DB_FILE        = process.env.IDD_DB_FILE || path.join(process.env.DATA_DIR || __dirname, 'idd.db');

// ─── Express + Socket.io setup ───────────────────────────────────────────────
const app = express();
// Deployment topology (see DEPLOY.md) is always exactly one reverse proxy
// (Caddy) in front of this service. Trusting exactly one hop — not an
// unbounded chain — is Express's documented setting for that topology: it
// makes req.ip and express-rate-limit's per-IP buckets reflect the real
// client (read from X-Forwarded-For) rather than Caddy's container address,
// without letting a client past Caddy spoof additional forwarded hops.
app.set('trust proxy', 1);
const { server: httpServer, tls } = makeServer(app);
const io         = new SocketIO(httpServer, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET','POST','PATCH','DELETE'] }
});

// Security headers + CORS (locked to ALLOWED_ORIGIN, not wildcard)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods',  'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options',        'nosniff');
  res.setHeader('X-Frame-Options',               'DENY');
  res.setHeader('X-XSS-Protection',              '1; mode=block');
  res.setHeader('Referrer-Policy',               'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com 'wasm-unsafe-eval'; " +
    "style-src 'self'; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "worker-src blob:;"
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  req.reqId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.reqId);
  const t0 = Date.now();
  res.on('finish', () => log.info('request', { reqId: req.reqId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
  next();
});

app.use(express.json({ limit: '50kb' }));

// ─── Rate limiter — 60 mutations per IP per minute ───────────────────────────
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok:false, error:'Too many requests — slow down' },
});

// ─── Login — strict rate limit to slow brute-force attempts ──────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok:false, error:'Too many login attempts — try again in 15 minutes' },
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString(), service: 'idd', uptime: process.uptime() }));
app.post('/api/login', loginLimiter, loginHandler);
app.post('/api/logout', requireAuth, logoutHandler);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'idd_production_app.html'));
});
app.get('/idd_production_app.js', (_req, res) => res.sendFile(path.join(__dirname, 'idd_production_app.js')));
// Static assets — block data files, secrets & backups (would leak the QC/NCR DB)
app.use((req, res, next) => {
  if (/\.(json|env|log|tmp|db)(-wal|-shm)?$/i.test(req.path) || /session_secret|users|revoked/i.test(req.path)) return res.status(404).end();
  next();
}, express.static(__dirname, { index: false }));
// Serve the app HTML (with injected token) at its direct path too
app.get('/idd_production_app.html', (_req, res) => res.redirect('/'));

// ─── Validation helpers ───────────────────────────────────────────────────────
const VALID_STATUSES   = new Set(['not_started','in_production','pending_qc',
                                   'qc_passed','ncr_open','ready_delivery','delivered']);
const VALID_SEVERITIES = new Set(['minor','major','critical']);
const VALID_RESULTS    = new Set(['pass','fail','na']);

/** Coerce v to a non-empty trimmed string ≤ maxLen chars, or return null. */
function str(v, maxLen = 2000) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= maxLen ? s : null;
}

// ─── Socket.io auth middleware ───────────────────────────────────────────────
io.use((socket, next) => {
  const user = authenticate(socket.handshake.auth?.token);
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  next();
});

// ─── Socket.io connection tracking + site rooms ──────────────────────────────
// Each socket joins exactly the rooms it is allowed to hear: HQ roles join the
// 'hq' room (they see all sites); everyone else joins only their own site room.
// Site-bearing events are emitted to the element's site room + 'hq', so a user
// at another site never receives another site's IDs, statuses, or actor names.
io.on('connection', socket => {
  const u = socket.user;
  if (seesAllSites(u.role)) socket.join('hq');
  else if (u.site)          socket.join(`site:${u.site}`);
  console.log(`  [WS] Client connected   · ${socket.id} · ${u.username} · ${seesAllSites(u.role) ? 'hq' : 'site:' + (u.site || 'none')} · total: ${io.engine.clientsCount}`);

  // Re-validate every 2 minutes. Catches token revocation, account deletion,
  // role changes, and site reassignments without waiting for a page reload.
  const reAuthTimer = setInterval(() => {
    const fresh = authenticate(socket.handshake.auth?.token);
    if (!fresh || fresh.role !== u.role || fresh.site !== (u.site ?? null)) {
      const reason = fresh
        ? 'Role or site changed — please reload'
        : 'Session expired or account removed';
      socket.emit('reauth_required', { reason });
      socket.disconnect(true);
    }
  }, 2 * 60 * 1000);

  socket.on('disconnect', () => {
    clearInterval(reAuthTimer);
    console.log(`  [WS] Client disconnected · ${socket.id} · total: ${io.engine.clientsCount}`);
  });
});

// Global broadcast — only for no-data signals (e.g. a refresh ping).
function broadcast(event, payload) { io.emit(event, payload); }
// Site-scoped broadcast — to the site's room and HQ only.
function broadcastSite(site, event, payload) {
  io.to(`site:${site}`).to('hq').emit(event, payload);
}

// ─── Relational store (better-sqlite3, WAL — see idd_store.js) ────────────────
const store = createStore(DB_FILE);

// Audit is hash-chained and written INSIDE each mutation's SQLite transaction
// (see idd_store.js: ctx.audit / store.audit). Audit and mutation therefore
// commit or roll back together — a mutation can never succeed without its audit
// record (fail-closed). auditMeta carries the actor/IP into the transaction.
const auditMeta = req => ({ actor: req.user?.username || 'unknown', ip: req.ip });

function uid() { return crypto.randomBytes(6).toString('hex'); }

// ─── Seed data ───────────────────────────────────────────────────────────────
const ELEMENT_TYPES = ['Wall Panel','Precast Beam','Precast Column','Precast Slab','PPVC Module'];
const STATUSES      = ['not_started','in_production','pending_qc','qc_passed','ncr_open','ready_delivery','delivered'];
const LEVELS        = ['L01','L02','L03','L04','L05','L06','L07','L08'];
// Multi-site: every element belongs to a site. Seed spans several sites so the
// HQ rollup and site-scoped access are exercised; production adds the rest via
// real data. A user is scoped to one site (HQ roles see all) — see auth.js.
const SITES = [
  { id:'SBW-N4',  name:'Sembawang N4 C16',     blocks:['Blk 301A','Blk 301B','Blk 302'] },
  { id:'TPN-GV',  name:'Tampines GreenVerge',  blocks:['Blk 501A','Blk 501B'] },
  { id:'JRW-N2',  name:'Jurong West N2',       blocks:['Blk 712','Blk 713'] },
  { id:'PSR-C38', name:'Pasir Ris C38',        blocks:['Blk 220A'] },
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
    { status:'delivered',      weight:10 }, { status:'ready_delivery', weight:8  },
    { status:'qc_passed',      weight:12 }, { status:'ncr_open',       weight:4  },
    { status:'pending_qc',     weight:7  }, { status:'in_production',  weight:6  },
    { status:'not_started',    weight:3  },
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
  // Stable weekly planned values — seeded once, never jitter on dashboard refresh
  const weeklyPlanned = Array.from({ length:6 }, () => 8 + Math.floor(Math.random() * 4));

  store.seed(elements, weeklyPlanned, auditEntry);
  console.log(`  Seeded ${elements.length} elements, ${ncrCount} NCRs`);
}

// ─── Seed on first run (or migrate from the interim blob format) ─────────────
if (store.migrateLegacyBlob()) console.log('  [DB] migrated legacy blob → relational tables');
else if (store.isEmpty()) seedDB();

// ─── Site scoping ─────────────────────────────────────────────────────────────
// HQ roles (gm/management/head_of_it) see all sites — and may narrow with ?site=.
// Everyone else is locked to their own assigned site; unassigned → no data.
function readSite(req) {
  if (seesAllSites(req.user.role)) return req.query.site || null;   // null = all sites
  return req.user.site || '__none__';
}
function canAccessSite(req, site) {
  return seesAllSites(req.user.role) || req.user.site === site;
}

// List the sites visible to the caller (HQ: all; site user: just theirs).
app.get('/api/production/sites', requireAuth, (req, res) => {
  const all = store.sites();
  res.json(seesAllSites(req.user.role) ? all : all.filter(s => s.site === req.user.site));
});

// ─── Dashboard endpoint ──────────────────────────────────────────────────────
app.get('/api/production/dashboard', requireAuth, (req, res) => {
  const { statusCounts, typeCounts, total, actualDates, openNCRs, closedNCRs,
          bySite, site, weeklyPlanned, lastUpdated } = store.dashboardRaw(readSite(req));

  const byStatus = {};
  STATUSES.forEach(s => { byStatus[s] = statusCounts[s] || 0; });

  const passed    = (byStatus.qc_passed||0) + (byStatus.ready_delivery||0) + (byStatus.delivered||0);
  const inProd    =  byStatus.in_production  || 0;
  const pendingQC =  byStatus.pending_qc     || 0;
  const ncrOpen   =  byStatus.ncr_open       || 0;
  const readyDel  =  byStatus.ready_delivery || 0;
  const delivered =  byStatus.delivered      || 0;

  // Weekly production — planned values come from meta so they never jitter
  const now = new Date();
  const weeks = weeklyPlanned.map((planned, i) => {
    const w = 5 - i;
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - w * 7 - 6);
    const weekEnd   = new Date(now); weekEnd.setDate(weekEnd.getDate()   - w * 7);
    const label  = `W${i + 1}`;
    const actual = actualDates.filter(d => {
      const dt = new Date(d);
      return dt >= weekStart && dt <= weekEnd;
    }).length;
    return { label, planned, actual };
  });

  const cumul = { planned:[], actual:[] };
  let cumPlan = 0, cumActual = 0;
  weeks.forEach(w => {
    cumPlan   += w.planned;
    cumActual += w.actual;
    cumul.planned.push(cumPlan);
    cumul.actual.push(cumActual);
  });

  res.json({
    site, bySite,   // bySite is the HQ per-site rollup (null when scoped to one site)
    total, passed, inProd, pendingQC, ncrOpen, readyDel, delivered,
    completionRate: total ? Math.round((passed / total) * 100) : 0,
    byStatus, byType: typeCounts, weeks, cumul,
    openNCRs, closedNCRs, lastUpdated,
  });
});

// ─── Element list ─────────────────────────────────────────────────────────────
app.get('/api/production/elements', requireAuth, (req, res) => {
  const q = { ...req.query };
  const scoped = readSite(req);
  if (!seesAllSites(req.user.role)) q.site = scoped;   // site users locked to their site
  res.json(store.listElements(q));
});

// ─── Element detail ───────────────────────────────────────────────────────────
app.get('/api/production/elements/:id', requireAuth, (req, res) => {
  const el = store.getElement(req.params.id);
  if (!el) return res.status(404).json({ error:'Not found' });
  if (!canAccessSite(req, el.site)) return res.status(403).json({ ok:false, error:'Forbidden — element belongs to another site' });
  res.json(el);
});

// ─── Update element status ────────────────────────────────────────────────────
app.patch('/api/production/elements/:id/status', requireRole('inspector'), mutationLimiter, (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.has(status))
    return res.status(400).json({ ok:false, error:'Invalid status value' });
  const byStr = req.user.username;  // identity from verified token, not request body
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error:'Forbidden — element belongs to another site' });

  const el = store.withElement(req.params.id, (el, ctx) => {
    el.statusHistory.push({ from:el.status, to:status, by:byStr, at:new Date().toISOString() });
    el.status    = status;
    el.updatedAt = new Date().toISOString();
    if (status === 'in_production') el.actualProductionDate = new Date().toISOString().split('T')[0];
    ctx.audit('element.status', { elementId:el.id, status:el.status });
    return el;
  }, auditMeta(req));
  if (el === store.NOT_FOUND) return res.status(404).json({ error:'Not found' });

  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, by:byStr, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, element:el });
});

// ─── Submit / update inspection checklist ────────────────────────────────────
app.patch('/api/production/elements/:id/checklist', requireRole('inspector'), mutationLimiter, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error:'items must be an array' });
  const checkedByStr = req.user.username;  // identity from verified token
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error:'Forbidden — element belongs to another site' });

  const el = store.withElement(req.params.id, (el, ctx) => {
    items.forEach(upd => {
      if (!upd?.id) return;
      const item = el.checklist.find(i => i.id === upd.id);
      if (!item) return;
      if (upd.result !== undefined && VALID_RESULTS.has(upd.result)) item.result = upd.result;
      if (typeof upd.remarks  === 'string') item.remarks  = upd.remarks.slice(0, 1000);
      if (typeof upd.photoUrl === 'string') item.photoUrl = upd.photoUrl.slice(0, 500);
      item.checkedBy = checkedByStr;
      item.checkedAt = new Date().toISOString();
    });

    // Auto-advance status when all items are checked
    const allChecked = el.checklist.every(i => i.result !== null);
    const anyFail    = el.checklist.some(i => i.result === 'fail');
    if (allChecked) {
      const newStatus = anyFail ? 'ncr_open' : 'qc_passed';
      el.statusHistory.push({ from:el.status, to:newStatus, by:checkedByStr, at:new Date().toISOString() });
      el.status = newStatus;
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('element.checklist', { elementId:el.id, status:el.status });
    return el;
  }, auditMeta(req));
  if (el === store.NOT_FOUND) return res.status(404).json({ error:'Not found' });

  broadcastSite(el.site, 'element:updated', {
    id:el.id, status:el.status, by:checkedByStr,
    checklistPct: Math.round(el.checklist.filter(i => i.result !== null).length / el.checklist.length * 100),
    updatedAt: el.updatedAt,
  });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, element:el });
});

// ─── Raise NCR ────────────────────────────────────────────────────────────────
app.post('/api/production/elements/:id/ncrs', requireRole('inspector'), mutationLimiter, (req, res) => {
  const description = str(req.body.description, 2000);
  if (!description)
    return res.status(400).json({ ok:false, error:'description is required (max 2000 chars)' });

  const severity = VALID_SEVERITIES.has(req.body.severity) ? req.body.severity : 'minor';
  const location = str(req.body.location, 500) || '';
  const raisedBy = req.user.username;  // identity from verified token
  if (!canAccessSite(req, store.elementSite(req.params.id)))
    return res.status(403).json({ ok:false, error:'Forbidden — element belongs to another site' });

  const out = store.withElement(req.params.id, (el, ctx) => {
    // Counter incremented inside the same transaction — no collision risk
    const ncr = {
      id: uid(), elementId:el.id, ncrNo: ctx.nextNcrNo(), description, severity, location, raisedBy,
      raisedAt: new Date().toISOString(),
      status: 'open', correctiveAction:'', closedBy:null, closedAt:null, photos:[],
    };
    el.ncrs.push(ncr);
    if (el.status !== 'ncr_open') {
      el.statusHistory.push({ from:el.status, to:'ncr_open', by:raisedBy, at:new Date().toISOString() });
      el.status = 'ncr_open';
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('ncr.raise', { elementId:el.id, ncrNo:ncr.ncrNo, severity:ncr.severity });
    return { el, ncr };
  }, auditMeta(req));
  if (out === store.NOT_FOUND) return res.status(404).json({ error:'Not found' });
  const { el, ncr } = out;

  broadcastSite(el.site, 'ncr:raised',      { ncrNo:ncr.ncrNo, elementId:el.id, severity:ncr.severity, raisedBy:ncr.raisedBy });
  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.status(201).json({ ok:true, ncr });
});

// ─── Close / update NCR ───────────────────────────────────────────────────────
app.patch('/api/production/ncrs/:ncrId', requireRole('supervisor'), mutationLimiter, (req, res) => {
  const { status, correctiveAction } = req.body;
  if (status && !['open','in_progress','closed'].includes(status))
    return res.status(400).json({ ok:false, error:'Invalid NCR status' });
  if (!canAccessSite(req, store.ncrSite(req.params.ncrId)))
    return res.status(403).json({ ok:false, error:'Forbidden — NCR belongs to another site' });

  const out = store.withNcr(req.params.ncrId, (el, ncr, ctx) => {
    if (status) ncr.status = status;
    if (correctiveAction !== undefined) ncr.correctiveAction = str(correctiveAction, 2000) || ncr.correctiveAction;
    if (status === 'closed') {
      ncr.closedBy = req.user.username;  // identity from verified token
      ncr.closedAt = new Date().toISOString();
    }
    if (status === 'closed' && el.ncrs.every(n => n.status === 'closed')) {
      el.statusHistory.push({ from:el.status, to:'pending_qc', by:req.user.username, at:new Date().toISOString() });
      el.status = 'pending_qc';
    }
    el.updatedAt = new Date().toISOString();
    ctx.audit('ncr.update', { ncrNo:ncr.ncrNo, status:ncr.status });
    return { el, ncr };
  }, auditMeta(req));
  if (out === store.NOT_FOUND) return res.status(404).json({ error:'NCR not found' });
  const { el, ncr } = out;

  broadcastSite(el.site, 'ncr:updated',     { id:ncr.id, ncrNo:ncr.ncrNo, status:ncr.status, elementId:ncr.elementId });
  broadcastSite(el.site, 'element:updated', { id:el.id, status:el.status, updatedAt:el.updatedAt });
  broadcastSite(el.site, 'dashboard:refresh', {});
  res.json({ ok:true, ncr });
});

// ─── All NCRs ─────────────────────────────────────────────────────────────────
app.get('/api/production/ncrs', requireAuth, (req, res) => {
  const site = seesAllSites(req.user.role) ? req.query.site : (req.user.site || '__none__');
  res.json(store.listNcrs(req.query.status, site));
});

// ─── Reset to seed (dev utility — admin only) ────────────────────────────────
app.post('/api/production/reset', requireAdmin, mutationLimiter, (req, res) => {
  // Back up current data (exported from SQLite) before wiping. Written under
  // DATA_DIR (the mounted volume) — __dirname is /app in the container, which
  // is not writable by the unprivileged `node` user the entrypoint drops to
  // (only /data is chowned), so a backup there would fail with EACCES.
  const backup = path.join(process.env.DATA_DIR || __dirname, `idd_data_backup_${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(store.exportAll(), null, 2));
  // Reset and its audit record commit in one transaction (see store.seed).
  seedDB({ ...auditMeta(req), action: 'db.reset', details: { backup: path.basename(backup) } });
  broadcast('dashboard:refresh', {});
  res.json({ ok:true, message:'Database reset to seed data', backup: path.basename(backup) });
});

// ─── Audit chain verification (admin) ────────────────────────────────────────
app.get('/api/production/audit/verify', requireAdmin, (_req, res) => {
  res.json(store.verifyAuditChain());
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  IDD Digital Production Server  —  REAL-TIME  HDB BSS S77║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  const scheme = tls ? 'https' : 'http';
  console.log(`  REST API:  ${scheme}://localhost:${PORT}/api/production/dashboard`);
  console.log(`  WebSocket: ${tls ? 'wss' : 'ws'}://localhost:${PORT}   (Socket.io)`);
  console.log(`  Frontend:  ${scheme}://localhost:${PORT}/`);
  console.log(`  Data:      ${DB_FILE} (SQLite, WAL)`);
  const { elements: nEl, ncrs: nNcr } = store.counts();
  console.log(`  Records:   ${nEl} elements, ${nNcr} NCRs`);
  if (ALLOWED_ORIGIN !== `http://localhost:${PORT}`)
    console.log(`  CORS:      ${ALLOWED_ORIGIN}`);
  console.log(`  Auth:      per-user login (manage users: node auth.js add-user <name> <password>)`);
  console.log(`  TLS:       ${tls ? '✓ HTTPS enabled' : '⚠ HTTP — terminate TLS at a reverse proxy for non-local use'}`);
  console.log('\n  Multi-tab: open in several tabs/devices to see real-time sync\n');
});
