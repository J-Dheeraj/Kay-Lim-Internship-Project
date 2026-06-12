/**
 * Kay Lim Construction Dashboard — Backend Proxy Server
 * Node.js / Express (ESM)
 *
 * Exposes safe proxy routes so the browser never sees any API keys.
 * All secrets live in .env only.
 *
 * Real integrations implemented:
 *   ✅  Autodesk Platform Services (APS) — 2-legged OAuth + Issues API v1 + Quality Checklists v1
 *   ✅  Power BI Embedded — Azure AD service-principal auth + Reports + GenerateToken
 *   ⏳  Insight QSE (CAPPS) — mock data; contact CAPPS (contact@capps.com.sg / +65 6509 0309) for API key
 *   ⏳  UniCon — mock data; contact UniCon support at app.unicongroup.co for API access
 */

import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:3000,http://127.0.0.1:3001').split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes(o)) ? cb(null, true) : cb(new Error('CORS blocked: ' + o)) }));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// fetch with timeout — a hung vendor API can no longer stall requests indefinitely
async function fetchT(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetchT(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// ─────────────────────────────────────────────────────────────────────────────
// APS / ACC — 2-legged OAuth (token cache)
// Docs: https://aps.autodesk.com/en/docs/oauth/v2/reference/http/gettoken/
// ─────────────────────────────────────────────────────────────────────────────
const APS_BASE   = 'https://developer.api.autodesk.com';
const ACC_ACCOUNT = process.env.ACC_ACCOUNT_ID  || 'your_acc_account_id';
const ACC_PROJECT = process.env.ACC_PROJECT_ID  || 'your_acc_project_id';

// Shared client-credentials OAuth helper (used by APS + Power BI)
async function oauthToken(cache, url, params, name) {
  if (cache.token && Date.now() < cache.expiry - 30_000) return cache.token;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  if (!res.ok) throw new Error(`${name} auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cache.token  = data.access_token;
  cache.expiry = Date.now() + data.expires_in * 1000;
  return cache.token;
}

const _apsCache = { token: null, expiry: 0 };

async function getApsToken() {
  const id  = process.env.APS_CLIENT_ID;
  const sec = process.env.APS_CLIENT_SECRET;
  if (!id || !sec) throw new Error('APS_CLIENT_ID / APS_CLIENT_SECRET not set in .env');
  return oauthToken(_apsCache, `${APS_BASE}/authentication/v2/token`, new URLSearchParams({
    grant_type: 'client_credentials', client_id: id, client_secret: sec, scope: 'data:read'
  }), 'APS');
}

// ─────────────────────────────────────────────────────────────────────────────
// Power BI — Azure AD service-principal OAuth
// Docs: https://learn.microsoft.com/en-us/power-bi/developer/embedded/embed-service-principal
// Setup steps (one-time, by Kay Lim IT admin):
//   1. Register an app in Entra (Azure AD) → get PBI_CLIENT_ID + PBI_CLIENT_SECRET
//   2. Create a security group → add the service principal
//   3. Power BI Admin portal → Tenant settings → enable "Allow service principals to use Power BI APIs" for that group
//   4. Add the service principal as Member/Admin to the workspace
// ─────────────────────────────────────────────────────────────────────────────
const _pbiCache = { token: null, expiry: 0 };

async function getPbiToken() {
  const tid = process.env.PBI_TENANT_ID;
  const cid = process.env.PBI_CLIENT_ID;
  const sec = process.env.PBI_CLIENT_SECRET;
  if (!tid || !cid || !sec) throw new Error('PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET not set in .env');
  return oauthToken(_pbiCache, `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, new URLSearchParams({
    grant_type: 'client_credentials', client_id: cid, client_secret: sec,
    scope: 'https://analysis.windows.net/powerbi/api/.default'
  }), 'PBI');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function mock(data) {
  return { ...data, _source: 'mock' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─────────────────────────────────────────────────────────────────────────────
// Integration status (shows which APIs are configured)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/integrations/status', (_req, res) => {
  res.json({
    acc:    { configured: !!(process.env.APS_CLIENT_ID && process.env.APS_CLIENT_SECRET), label: 'Autodesk Construction Cloud' },
    pbi:    { configured: !!(process.env.PBI_TENANT_ID && process.env.PBI_CLIENT_ID && process.env.PBI_CLIENT_SECRET), label: 'Power BI Embedded' },
    qse:    { configured: !!(process.env.QSE_API_KEY),    label: 'Insight QSE (CAPPS)' },
    unicon: { configured: !!(process.env.UNICON_API_KEY), label: 'UniCon' }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Issues (RFIs + Defects combined)
// GET /construction/issues/v1/projects/{projectId}/issues
// Filters: filter[status], filter[issueTypeId], filter[issueSubtypeId],
//          filter[assignedTo], filter[dueDate], filter[search], limit, offset
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/rfis', async (req, res) => {
  try {
    const token = await getApsToken();
    const url   = `${APS_BASE}/construction/issues/v1/projects/${ACC_PROJECT}/issues?limit=100&sortBy=-createdAt`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC issues ${r.status}`);
    const data  = await r.json();
    // Normalise response: ACC returns {results:[...], pagination:{...}}
    const results = (data.results || []).map(i => ({
      id:          i.displayId || i.id,
      subject:     i.title || '(No title)',
      status:      i.status,                         // open | in_review | completed | void | draft
      discipline:  i.issueSubtypeId || '—',          // resolve to name via /issue-types if needed
      assignedTo:  i.assignedToName || i.assignedTo || '—',
      dueDate:     i.dueDate ? i.dueDate.split('T')[0] : '—',
      agedays:     i.createdAt ? Math.floor((Date.now() - new Date(i.createdAt)) / 86400000) : 0,
      location:    i.locationDescription || '—',
      source:      'live'
    }));
    res.json({ results, pagination: data.pagination });
  } catch (e) {
    console.warn('[/api/rfis] falling back to mock:', e.message);
    res.json(mock({
      results: [
        { id:'RFI-001', subject:'Column grid offset @ L3 Structural', discipline:'Structural', assignedTo:'Tan Wei Ming', status:'open',    dueDate:'2026-06-15', agedays:8  },
        { id:'RFI-002', subject:'M&E duct routing conflict — B1 carpark', discipline:'M&E',       assignedTo:'Lim Ah Kow',   status:'open',    dueDate:'2026-06-12', agedays:5  },
        { id:'RFI-003', subject:'Curtain wall fin alignment L12',     discipline:'Architectural', assignedTo:'Sarah Ng',    status:'closed',  dueDate:'2026-05-30', agedays:22 },
        { id:'RFI-004', subject:'Rebar spacing — transfer slab',       discipline:'Structural', assignedTo:'Ahmad Fauzi',  status:'overdue', dueDate:'2026-06-01', agedays:30 },
        { id:'RFI-005', subject:'Drainage invert level @ carpark L1',  discipline:'Civil',      assignedTo:'Chan Beng Hwa',status:'open',    dueDate:'2026-06-18', agedays:3  },
        { id:'RFI-006', subject:'Fire-rated door supplier change',      discipline:'Architectural', assignedTo:'Sarah Ng', status:'closed',  dueDate:'2026-05-25', agedays:27 },
        { id:'RFI-007', subject:'Roof waterproofing membrane spec',     discipline:'Architectural', assignedTo:'Tan Wei Ming',status:'open',  dueDate:'2026-06-20', agedays:1  },
        { id:'RFI-008', subject:'Generator room ventilation top-up',    discipline:'M&E',         assignedTo:'Lim Ah Kow', status:'overdue', dueDate:'2026-06-03', agedays:28 },
      ]
    }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Defects (same issues endpoint, filtered by category)
// In ACC, defects are Issues with a specific issueTypeId — query without filter
// and let the dashboard filter client-side, or pass filter[issueTypeId]=<defect-type-id>
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/defects', async (req, res) => {
  try {
    const token = await getApsToken();
    // Fetch open issues — the dashboard treats those with severity tags as defects
    const url   = `${APS_BASE}/construction/issues/v1/projects/${ACC_PROJECT}/issues?limit=50&filter[status]=open`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC defects ${r.status}`);
    const data  = await r.json();
    const results = (data.results || []).map(i => ({
      id:       i.displayId || i.id,
      title:    i.title,
      status:   i.status,
      severity: i.priority || 'minor',   // ACC uses priority: 1=critical 2=major 3=minor
      location: i.locationDescription || '—',
      source:   'live'
    }));
    res.json({ results });
  } catch (e) {
    console.warn('[/api/defects] falling back to mock:', e.message);
    res.json(mock({
      results: [
        { id:'DEF-001', title:'Hollow tile @ L5 toilet',        status:'open',   severity:'major',    location:'L5 Unit 5A' },
        { id:'DEF-002', title:'Hairline crack wall finishes L6', status:'open',   severity:'minor',    location:'L6 Corridor' },
        { id:'DEF-003', title:'Exposed rebar @ roof slab',       status:'open',   severity:'critical', location:'Roof Level' },
        { id:'DEF-004', title:'Water seepage basement carpark',  status:'open',   severity:'major',    location:'B1 Carpark' },
        { id:'DEF-005', title:'Misaligned door frame L7-02',     status:'open',   severity:'minor',    location:'L7 Unit 7-02' },
        { id:'DEF-006', title:'Defective ACMV grille L4',        status:'closed', severity:'minor',    location:'L4 Corridor' },
      ]
    }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Quality Checklists
// GET /quality/v1/projects/{projectId}/checklists
// Docs: https://aps.autodesk.com/en/docs/acc/v1/reference/http/quality-checklistInstances-GET/
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/qaqc', async (req, res) => {
  try {
    const token = await getApsToken();
    const url   = `${APS_BASE}/quality/v1/projects/${ACC_PROJECT}/checklistInstances?limit=50`;
    const r     = await fetchT(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`ACC checklists ${r.status}`);
    const data  = await r.json();
    const results = (data.results || []).map(c => ({
      id:         c.id,
      name:       c.name || c.templateName,
      type:       c.type || c.categoryName || 'General',
      status:     c.status,       // draft | active | completed | overdue
      passRate:   c.conformingCount && c.totalCount
                    ? Math.round((c.conformingCount / c.totalCount) * 100)
                    : null,
      location:   c.locationDescription || '—',
      dueDate:    c.dueDate ? c.dueDate.split('T')[0] : '—',
      assignedTo: c.assignedTo || '—',
      source:     'live'
    }));
    res.json({ results });
  } catch (e) {
    console.warn('[/api/qaqc] falling back to mock:', e.message);
    res.json(mock({
      results: [
        { id:'CL-001', name:'Pre-Pour Checklist L5 Slab',   type:'Structural', status:'completed', passRate:95, location:'L5', dueDate:'2026-06-08', assignedTo:'Ahmad Fauzi' },
        { id:'CL-002', name:'M&E Rough-In 1st Fix L4',       type:'M&E',        status:'active',    passRate:80, location:'L4', dueDate:'2026-06-14', assignedTo:'Lim Ah Kow' },
        { id:'CL-003', name:'Arch Finishes L6',               type:'Arch Finish',status:'active',    passRate:88, location:'L6', dueDate:'2026-06-16', assignedTo:'Sarah Ng' },
        { id:'CL-004', name:'Pre-Handover Inspection Unit 3A',type:'Pre-HO',     status:'overdue',   passRate:75, location:'L3', dueDate:'2026-06-05', assignedTo:'Tan Wei Ming' },
        { id:'CL-005', name:'Fire-Stop Checklist B1',         type:'Fire Stop',  status:'completed', passRate:90, location:'B1', dueDate:'2026-06-07', assignedTo:'Chan Beng Hwa' },
      ]
    }));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Progress / Schedule (no native ACC schedule API)
// Alternative: use ACC Model Properties API to read % complete from BIM models,
// or pull from an external schedule tool (MS Project, Primavera) via ERP/API.
// For now: mock data with correct structure
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/progress', (_req, res) => {
  res.json(mock({
    overall: 67,
    plannedToDate: 72,
    categories: [
      { name:'Structural Works',    planned:80, actual:75 },
      { name:'M&E 1st Fix',         planned:65, actual:60 },
      { name:'Architectural Works', planned:50, actual:42 },
      { name:'Drainage & External', planned:90, actual:88 },
      { name:'Landscaping',         planned:20, actual:10 }
    ],
    weekly: [
      { week:'W1', planned:15, actual:14 },{ week:'W2', planned:25, actual:24 },
      { week:'W3', planned:35, actual:34 },{ week:'W4', planned:48, actual:47 },
      { week:'W5', planned:60, actual:59 },{ week:'W6', planned:72, actual:67 }
    ]
    // TODO: Replace with ACC Model Properties API or linked schedule source
    // GET /construction/locations/v1/projects/{projectId}/nodes — for LBS
    // GET /modelderivative/v2/designdata/{urn}/metadata — for BIM % complete
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// ACC — Manpower / Daily Log
// ACC has a Daily Log (field reports) tool — no public REST API as of Jun 2026.
// Alternatives: IDD Platform UC10 manpower data, PayAdvisorMobile® HRMS (CAPPS).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/manpower', (_req, res) => {
  res.json(mock({
    today: 148, target: 155, utilisation: 95.5,
    trades: [
      { trade:'Concretor',  count:22 },{ trade:'Carpenter',  count:18 },
      { trade:'Plasterer',  count:18 },{ trade:'Electrician',count:14 },
      { trade:'Plumber',    count:12 },{ trade:'Tiler',      count:10 },
      { trade:'Others',     count:54 }
    ]
    // TODO: Integrate with PayAdvisorMobile® HRMS (CAPPS, same vendor as Insight QSE)
    // or with the IDD Platform (BCA) UC10 manpower tracking feed
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Insight QSE — CAPPS Solutions (kaylim.insightqse.com)
//
// CAPPS does NOT publish a public REST API.
// To obtain API access, contact:
//   📧 contact@capps.com.sg
//   📞 +65 6509 0309
//   🏢 8 Burn Road #06-09/10, Trivex, Singapore 369977
//
// When CAPPS provides credentials, set in .env:
//   QSE_BASE_URL=https://kaylim.insightqse.com
//   QSE_API_KEY=<key from CAPPS>
//
// Expected endpoints (to confirm with CAPPS):
//   GET /api/v1/inspections?type=quality&projectId=...
//   GET /api/v1/safety/inspections
//   GET /api/v1/ptw/permits
//   GET /api/v1/attendance/workers
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/qse/inspections', async (_req, res) => {
  const base = process.env.QSE_BASE_URL;
  const key  = process.env.QSE_API_KEY;
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/v1/inspections`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`QSE ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/qse/inspections] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    results: [
      { id:'QI-001', type:'Pre-Pour Concrete',     location:'L5 Grid C-D/3-4',  inspector:'Ahmad Fauzi',  defects:0, status:'closed', date:'2026-06-08' },
      { id:'QI-002', type:'M&E Rough-In 1st Fix',   location:'L4 Zone B',        inspector:'Lim Ah Kow',   defects:3, status:'open',   date:'2026-06-09' },
      { id:'QI-003', type:'Architectural Finishes', location:'L6 Unit 6B',       inspector:'Sarah Ng',     defects:1, status:'open',   date:'2026-06-09' },
      { id:'QI-004', type:'Pre-Handover',            location:'L3 Unit 3A',       inspector:'Tan Wei Ming', defects:5, status:'open',   date:'2026-06-07' },
      { id:'QI-005', type:'Structural M&E',          location:'B1 Risers',        inspector:'Chan Beng Hwa',defects:0, status:'closed', date:'2026-06-06' },
    ]
  }));
});

app.get('/api/qse/safety', async (_req, res) => {
  const base = process.env.QSE_BASE_URL;
  const key  = process.env.QSE_API_KEY;
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/v1/safety/inspections`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`QSE Safety ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/qse/safety] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    open: 8, closed: 44, thisWeek: 3,
    categories: [
      { name:'PPE',          count:6 },{ name:'Housekeeping', count:8 },
      { name:'Scaffolding',  count:4 },{ name:'Fire Safety',  count:2 },
      { name:'Other',        count:2 }
    ],
    trend: [
      { month:'Jan',raised:8,closed:7 },{ month:'Feb',raised:12,closed:11 },
      { month:'Mar',raised:7,closed:7 },{ month:'Apr',raised:10,closed:9 },
      { month:'May',raised:9,closed:9 },{ month:'Jun',raised:6,closed:4 }
    ],
    inspections: [
      { date:'2026-06-09', type:'Daily',  inspector:'Wong Kai Feng', infringements:2, status:'open'   },
      { date:'2026-06-09', type:'Random', inspector:'Rajan Kumar',   infringements:0, status:'closed' },
      { date:'2026-06-08', type:'Daily',  inspector:'Wong Kai Feng', infringements:1, status:'closed' },
    ]
  }));
});

app.get('/api/qse/ptw', async (_req, res) => {
  const base = process.env.QSE_BASE_URL;
  const key  = process.env.QSE_API_KEY;
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/v1/ptw/permits`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`QSE PTW ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/qse/ptw] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    results: [
      { id:'PTW-001', work:'Hot Work — Welding',      location:'L5 Structural Frame', issuer:'Ahmad Fauzi',   expiry:'2026-06-09 17:00', status:'active'   },
      { id:'PTW-002', work:'Confined Space Entry',    location:'Underground Sump',    issuer:'Rajan Kumar',   expiry:'2026-06-09 16:00', status:'expiring' },
      { id:'PTW-003', work:'Working at Height >3m',   location:'L8 Roof Form',        issuer:'Chan Beng Hwa', expiry:'2026-06-09 18:00', status:'active'   },
      { id:'PTW-004', work:'Electrical Isolation',    location:'MSB Room B1',         issuer:'Lim Ah Kow',    expiry:'2026-06-10 08:00', status:'active'   },
      { id:'PTW-005', work:'Hot Work — Cutting',      location:'L6 Architectural',    issuer:'Ahmad Fauzi',   expiry:'2026-06-08 17:00', status:'expired'  },
    ]
  }));
});

app.get('/api/qse/attendance', async (_req, res) => {
  const base = process.env.QSE_BASE_URL;
  const key  = process.env.QSE_API_KEY;
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/v1/attendance/workers`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`QSE Attendance ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/qse/attendance] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    todayTotal: 148, expected: 155,
    trades: [
      { trade:'Concretor',  count:22 },{ trade:'Carpenter',  count:18 },
      { trade:'Plasterer',  count:18 },{ trade:'Electrician',count:14 },
      { trade:'Plumber',    count:12 },{ trade:'Tiler',      count:10 },
      { trade:'Others',     count:54 }
    ],
    weekly: [
      { day:'Mon',present:145,expected:155 },{ day:'Tue',present:150,expected:155 },
      { day:'Wed',present:155,expected:155 },{ day:'Thu',present:148,expected:155 },
      { day:'Fri',present:148,expected:155 }
    ]
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// UniCon (app.unicongroup.co)
//
// UniCon is a Flutter-based app with no documented public API.
// Contact UniCon support via https://app.unicongroup.co or support@unicongroup.co
// to request API / webhook credentials for Kay Lim Company ID: your_unicon_company_id
//
// Once credentials are available, set in .env:
//   UNICON_BASE_URL=https://app.unicongroup.co
//   UNICON_API_KEY=<token from UniCon support>
//   UNICON_COMPANY_ID=your_unicon_company_id
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/unicon/projects', async (_req, res) => {
  const base = process.env.UNICON_BASE_URL;
  const key  = process.env.UNICON_API_KEY;
  const cid  = process.env.UNICON_COMPANY_ID || 'your_unicon_company_id';
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/companies/${cid}/projects`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`UniCon projects ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/unicon/projects] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    results: [
      { id:'p1', name:'Sembawang Block 312 (HDB)',     status:'active',   progress:68, dueDate:'2027-03-31', budget:42_000_000, spent:28_560_000, tasks:{ done:142, total:210 } },
      { id:'p2', name:'Jurong West RC Frame (MUP)',    status:'active',   progress:26, dueDate:'2027-12-31', budget:15_000_000, spent:3_900_000,  tasks:{ done:38,  total:146 } },
      { id:'p3', name:'Tampines PPVC Residential',     status:'active',   progress:17, dueDate:'2028-06-30', budget:28_000_000, spent:4_760_000,  tasks:{ done:22,  total:130 } },
    ]
  }));
});

app.get('/api/unicon/tasks', async (_req, res) => {
  const base = process.env.UNICON_BASE_URL;
  const key  = process.env.UNICON_API_KEY;
  const cid  = process.env.UNICON_COMPANY_ID || 'your_unicon_company_id';
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/companies/${cid}/tasks`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`UniCon tasks ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/unicon/tasks] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    open: 34, inProgress: 18, completed: 34, overdue: 7, dueToday: 5,
    tasks: [
      { id:'t1', name:'Install formwork L5 Col C3', project:'Sembawang', assignedTo:'Ahmad Fauzi',   dueDate:'2026-06-10', status:'inProgress', priority:'high'   },
      { id:'t2', name:'M&E roughing L4 Zone A',     project:'Sembawang', assignedTo:'Lim Ah Kow',    dueDate:'2026-06-11', status:'open',       priority:'medium' },
      { id:'t3', name:'RC raft foundation pour',     project:'Jurong',   assignedTo:'Chan Beng Hwa', dueDate:'2026-06-08', status:'overdue',    priority:'high'   },
      { id:'t4', name:'Hoist maintenance check',    project:'Sembawang', assignedTo:'Wong Kai Feng', dueDate:'2026-06-10', status:'open',       priority:'low'    },
      { id:'t5', name:'PPVC module delivery TT22',  project:'Tampines',  assignedTo:'Rajan Kumar',   dueDate:'2026-06-12', status:'open',       priority:'medium' },
    ]
  }));
});

app.get('/api/unicon/budget', async (_req, res) => {
  const base = process.env.UNICON_BASE_URL;
  const key  = process.env.UNICON_API_KEY;
  const cid  = process.env.UNICON_COMPANY_ID || 'your_unicon_company_id';
  if (base && key) {
    try {
      const r = await fetchT(`${base}/api/companies/${cid}/budget`, {
        headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`UniCon budget ${r.status}`);
      return res.json(await r.json());
    } catch (e) {
      console.warn('[/api/unicon/budget] live call failed, using mock:', e.message);
    }
  }
  res.json(mock({
    totalContract: 85_000_000, totalBilled: 37_220_000, forecast: 87_400_000,
    projects: [
      { name:'Sembawang Block 312', contract:42_000_000, billed:28_560_000, utilPct:68 },
      { name:'Jurong West RC',      contract:15_000_000, billed:3_900_000,  utilPct:26 },
      { name:'Tampines PPVC',       contract:28_000_000, billed:4_760_000,  utilPct:17 },
    ]
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Power BI — List reports in workspace
// GET https://api.powerbi.com/v1.0/myorg/groups/{workspaceId}/reports
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/powerbi-reports', async (_req, res) => {
  const wsId = process.env.PBI_WORKSPACE_ID;
  if (!wsId) return res.json(mock({ reports: [] }));
  try {
    const token = await getPbiToken();
    const r = await fetchT(`https://api.powerbi.com/v1.0/myorg/groups/${wsId}/reports`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`PBI reports ${r.status}`);
    const data = await r.json();
    res.json({ reports: (data.value || []).map(r => ({ id: r.id, name: r.name, embedUrl: r.embedUrl })) });
  } catch (e) {
    console.warn('[/api/powerbi-reports]', e.message);
    res.json(mock({ reports: [
      { id: process.env.PBI_REPORT_ID || 'placeholder', name: 'Kay Lim Construction Dashboard' }
    ]}));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Power BI — Generate embed token
// POST https://api.powerbi.com/v1.0/myorg/groups/{groupId}/reports/{reportId}/GenerateToken
// Requires: service principal added as Member/Admin to the workspace (see setup steps above)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/powerbi-embed', async (req, res) => {
  const wsId  = process.env.PBI_WORKSPACE_ID;
  const repId = req.query.reportId || process.env.PBI_REPORT_ID;
  if (!wsId || !repId) {
    return res.json(mock({
      note: 'Set PBI_WORKSPACE_ID and PBI_REPORT_ID in .env. See setup steps in server comments.'
    }));
  }
  try {
    const token = await getPbiToken();
    // Step 1: Get report details (for embedUrl + datasetId)
    const rptRes = await fetchT(`https://api.powerbi.com/v1.0/myorg/groups/${wsId}/reports/${repId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!rptRes.ok) throw new Error(`PBI report fetch ${rptRes.status}`);
    const rpt = await rptRes.json();

    // Step 2: Generate embed token (newer GenerateToken v2 API — supports multiple reports/datasets)
    const tokenRes = await fetchT(`https://api.powerbi.com/v1.0/myorg/GenerateToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasets: [{ id: rpt.datasetId }],
        reports:  [{ id: repId }]
      })
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      throw new Error(`PBI GenerateToken ${tokenRes.status}: ${errBody}`);
    }
    const embedToken = await tokenRes.json();

    res.json({
      embedToken: embedToken.token,
      embedUrl:   rpt.embedUrl,
      reportId:   repId,
      expiry:     embedToken.expiration,
      source:     'live'
    });
  } catch (e) {
    console.warn('[/api/powerbi-embed]', e.message);
    res.status(500).json({ error: e.message, source: 'error' });
  }
});

/* ══════════════════════════════════════════════════════════
   IDD QWC1 — DIGITAL PRODUCTION
   Data source: UniCon production module / CBOSS (BCA IDD platform)
   TODO: Once UniCon grants API access, replace mock with:
     GET ${UNICON_BASE_URL}/api/companies/${UNICON_COMPANY_ID}/idd/production
   or connect to CBOSS via BCA IDD Platform APIs.
   ══════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════
// IDD QWC1 — DIGITAL PRODUCTION
// Source: UniCon production module / CBOSS (BCA IDD platform)
// TODO: replace mock with live UniCon API once access is granted
// ══════════════════════════════════════════════════════════
app.get('/api/idd/production', async (_req, res) => {
  const key = process.env.UNICON_API_KEY;
  if (key) {
    try {
      const base = process.env.UNICON_BASE_URL || 'https://api.unicongroup.co';
      const cid  = process.env.UNICON_COMPANY_ID;
      const r = await fetchT(`${base}/api/companies/${cid}/idd/production`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
      });
      if (r.ok) return res.json(await r.json());
    } catch { /* fall through */ }
  }
  res.json({
    _source: 'mock',
    totalElements: 135,
    qcPassed:      99,
    inProduction:  28,
    openNCRs:       4,
    batches:        6,
    statusBreakdown: { passed: 99, inProduction: 28, ncr: 4, notStarted: 4 },
    weeklyRate: {
      labels:  ['Wk20','Wk21','Wk22','Wk23','Wk24'],
      planned: [12, 14, 14, 16, 14],
      actual:  [11, 13, 15, 14, 12]
    },
    cumulPlan:   [10, 22, 38, 55, 75, 98, 115],
    cumulActual: [ 9, 20, 36, 53, 71, null, null],
    qcPassRates: {
      types: ['PPVC Module','Wall Panel','Staircase','Beam','Column'],
      rates: [92, 100, 100, 75, 95]
    },
    batchList: [
      { id:'B-001', type:'PPVC Module',      factory:'YTL Precast, JB',     ordered:24, produced:18, qcStatus:'Passed',          targetDelivery:'2026-06-20', status:'In Production' },
      { id:'B-002', type:'Precast Wall Panel',factory:'Straits Precast, SG',ordered:60, produced:60, qcStatus:'Passed',          targetDelivery:'2026-06-15', status:'QC Passed'     },
      { id:'B-003', type:'PPVC Module',      factory:'YTL Precast, JB',     ordered:24, produced: 6, qcStatus:'Pending',         targetDelivery:'2026-07-10', status:'In Production' },
      { id:'B-004', type:'Precast Staircase',factory:'Straits Precast, SG',ordered:15, produced:15, qcStatus:'Passed',          targetDelivery:'2026-06-12', status:'QC Passed'     },
      { id:'B-005', type:'Precast Beam',     factory:'Straits Precast, SG',ordered: 8, produced: 4, qcStatus:'Failed - Rework',  targetDelivery:'2026-06-25', status:'NCR Raised'    },
      { id:'B-006', type:'PPVC Module',      factory:'YTL Precast, JB',     ordered: 4, produced: 0, qcStatus:'Not Started',    targetDelivery:'2026-07-30', status:'Not Started'   }
    ]
  });
});

// ══════════════════════════════════════════════════════════
// IDD QWC1 — DIGITAL LOGISTICS
// Source: UniCon logistics module / CBOSS (BCA IDD platform)
// TODO: replace mock with live UniCon API once access is granted
// ══════════════════════════════════════════════════════════
app.get('/api/idd/logistics', async (_req, res) => {
  const key = process.env.UNICON_API_KEY;
  if (key) {
    try {
      const base = process.env.UNICON_BASE_URL || 'https://api.unicongroup.co';
      const cid  = process.env.UNICON_COMPANY_ID;
      const r = await fetchT(`${base}/api/companies/${cid}/idd/logistics`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
      });
      if (r.ok) return res.json(await r.json());
    } catch { /* fall through */ }
  }
  res.json({
    _source: 'mock',
    deliveriesToday:    3,
    completedThisWeek: 18,
    onTimeRate:        89,
    pending:            9,
    weeklyPerf: {
      labels:    ['Wk20','Wk21','Wk22','Wk23','Wk24'],
      scheduled: [18, 21, 19, 22, 20],
      received:  [17, 20, 19, 21, 18]
    },
    onTimeTrend:       [84, 88, 85, 91, 89],
    onTimeTrendLabels: ['Feb','Mar','Apr','May','Jun'],
    categoryBreakdown: [
      { category:'PPVC Module',      count:18 },
      { category:'Precast Panel',    count:24 },
      { category:'Structural Steel', count:15 },
      { category:'M&E Equipment',    count:22 },
      { category:'Architectural',    count: 9 },
      { category:'Materials',        count:12 }
    ],
    deliveries: [
      { doNo:'DO-0042', item:'PPVC Module B-001 Units 1-6',         category:'PPVC Module',      supplier:'YTL Precast',     qty:'6 units',  scheduled:'2026-06-10 07:00', received:null,              craneSlot:'Crane 1 07:00-10:00', status:'scheduled' },
      { doNo:'DO-0041', item:'Rebar Bundle Ref R40-B2',             category:'Structural Steel', supplier:'Compact Metal',   qty:'12 tonnes',scheduled:'2026-06-09 13:00', received:'2026-06-09 13:45', craneSlot:null,                  status:'received'  },
      { doNo:'DO-0040', item:'Precast Wall Panel B-002 Units 55-60',category:'Precast Panel',    supplier:'Straits Precast', qty:'6 panels', scheduled:'2026-06-09 08:00', received:'2026-06-09 09:15', craneSlot:'Crane 2 08:00-11:00', status:'received'  },
      { doNo:'DO-0039', item:'Curtain Wall System CW-3',            category:'Architectural',    supplier:'Schindler Facades',qty:'1 lot',   scheduled:'2026-06-08 07:00', received:'2026-06-08 07:30', craneSlot:'Crane 1 07:00-09:00', status:'received'  },
      { doNo:'DO-0038', item:'M&E Chilled Water Pipes Pkg 3',       category:'M&E Equipment',    supplier:'Uni-Air Eng',     qty:'1 lot',    scheduled:'2026-06-07 14:00', received:'2026-06-08 09:00', craneSlot:null,                  status:'late'      },
      { doNo:'DO-0043', item:'Precast Staircase B-004 Units 13-15', category:'Precast Panel',    supplier:'Straits Precast', qty:'3 flights',scheduled:'2026-06-11 07:00', received:null,              craneSlot:'Crane 2 07:00-10:00', status:'pending'   },
      { doNo:'DO-0044', item:'Waterproofing Membrane Roof',         category:'Materials',        supplier:'Sika SG',         qty:'500 sqm',  scheduled:'2026-06-12 10:00', received:null,              craneSlot:null,                  status:'pending'   }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`\n🏗  Kay Lim Dashboard Backend — http://localhost:${PORT}`);
  console.log(`   ACC Project  : ${ACC_PROJECT}`);
  console.log(`   APS creds    : ${process.env.APS_CLIENT_ID  ? '✅ set' : '❌ missing — set APS_CLIENT_ID + APS_CLIENT_SECRET in .env'}`);
  console.log(`   Power BI     : ${process.env.PBI_TENANT_ID  ? '✅ set' : '⏳ set PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET / PBI_WORKSPACE_ID / PBI_REPORT_ID'}`);
  console.log(`   Insight QSE  : ${process.env.QSE_API_KEY    ? '✅ set' : '⏳ contact CAPPS (contact@capps.com.sg / +65 6509 0309) for API key'}`);
  console.log(`   UniCon       : ${process.env.UNICON_API_KEY ? '✅ set' : '⏳ contact UniCon support (app.unicongroup.co) for API access'}`);
  console.log(`   IDD QWC1     : Digital Production + Digital Logistics routes active (mock until UniCon API configured)\n`);
});
