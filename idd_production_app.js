// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Derive base URL from current page â€” works on any host, not just localhost
const BASE = window.location.origin;
const API  = BASE + '/api/production';

// â”€â”€â”€ Auth â€” per-user session token from POST /api/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let TOKEN       = sessionStorage.getItem('idd_token') || '';
let currentUser = sessionStorage.getItem('idd_user')  || '';

function authHeaders() { return TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}; }

function showLogin(msg) {
  const o = document.getElementById('login-overlay');
  o.style.display = 'flex';
  document.getElementById('login-error').textContent = msg || '';
}

async function doLogin(ev) {
  ev.preventDefault();
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  try {
    const r = await fetch(API.replace('/api/production','') + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) { showLogin(data.error || 'Login failed'); return; }
    sessionStorage.setItem('idd_token', data.token);
    sessionStorage.setItem('idd_user',  data.user.username);
    location.reload();  // restart with token â€” fetches + socket pick it up
  } catch { showLogin('Cannot reach server'); }
}

function handleUnauthorized() {
  sessionStorage.removeItem('idd_token');
  TOKEN = '';
  showLogin('Session expired â€” please log in again');
}

async function logout() {
  try { await fetch(API.replace('/api/production','') + '/api/logout', { method:'POST', headers: authHeaders() }); } catch {}
  sessionStorage.removeItem('idd_token');
  sessionStorage.removeItem('idd_user');
  TOKEN = '';
  location.reload();
}

let allElements      = [];
let currentElementId = null;
let scannerInstance  = null;
let scannedId        = null;

// â”€â”€â”€ Nav â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function nav(name, el) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('tab-' + name);
  if (sec) sec.classList.add('active');
  if (el) el.classList.add('active');
  document.querySelector('.sidebar')?.classList.remove('open');
  if (name === 'elements') { loadElements(); return; }
  if (name === 'ncrs')     { renderNCRs(); return; }
  if (name === 'qrcodes')  { renderQRCodes(); return; }
}

// â”€â”€â”€ Status helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STATUS_LABELS = {
  not_started:'Not Started', in_production:'In Production',
  pending_qc:'Pending QC', qc_passed:'QC Passed',
  ncr_open:'NCR Open', ready_delivery:'Ready for Delivery', delivered:'Delivered'
};
function badge(status) {
  return `<span class="s-badge s-${status}">${STATUS_LABELS[status]||status}</span>`;
}

// â”€â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = type === 'success' ? 'âœ“ ' + msg : 'âœ• ' + msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// â”€â”€â”€ HTML escape helper â€” apply to ALL server-supplied text in innerHTML â”€â”€â”€â”€
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

// esc() only escapes &, <, > (safe for HTML text content) â€” it does NOT
// escape quotes, so it is not safe for interpolating into an HTML attribute
// value. Use escAttr() for data-* attributes that carry dynamic IDs; click
// handling reads them back via .dataset (a delegated listener â€” see bottom
// of this script), never via inline onclick="...", so a value containing a
// quote or backslash can never break out into new markup or executable JS.
function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// â”€â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let chStatus, chWeekly, chCumul, chType;

async function loadDashboard() {
  const d = await tryFetch('/dashboard', null);
  if (!d) { console.error('Dashboard fetch failed'); return; }
  document.getElementById('kpi-total').textContent = d.total;
  document.getElementById('kpi-passed').textContent = d.passed;
  document.getElementById('kpi-pct').textContent = `${d.completionRate}% complete`;
  document.getElementById('kpi-inprod').textContent = d.inProd + d.pendingQC;
  document.getElementById('kpi-ncr').textContent = d.openNCRs;
  document.getElementById('ncr-badge').textContent = d.openNCRs;
  document.getElementById('last-updated').textContent = 'Last updated: ' + new Date(d.lastUpdated).toLocaleString('en-SG');

  const C = (s) => getComputedStyle(document.documentElement).getPropertyValue(s).trim();

  // Status doughnut
  const sLabels = ['QC Passed','Ready for Del.','Delivered','In Production','Pending QC','NCR Open','Not Started'];
  const sData   = [d.byStatus.qc_passed||0, d.byStatus.ready_delivery||0, d.byStatus.delivered||0,
                   d.byStatus.in_production||0, d.byStatus.pending_qc||0, d.byStatus.ncr_open||0, d.byStatus.not_started||0];
  const sColors = ['#22c55e','#3b82f6','#a855f7','#60a5fa','#fbbf24','#ef4444','#4b5563'];
  if (!chStatus) {
    chStatus = new Chart(document.getElementById('ch-status'), {
      type:'doughnut',
      data:{labels:sLabels, datasets:[{data:sData, backgroundColor:sColors, borderWidth:0}]},
      options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'right', labels:{color:'#9ca3af', boxWidth:10, padding:8, font:{size:11}}}}}
    });
  } else { chStatus.data.datasets[0].data = sData; chStatus.update(); }

  // Weekly bar
  const wk = d.weeks;
  if (!chWeekly) {
    chWeekly = new Chart(document.getElementById('ch-weekly'), {
      type:'bar',
      data:{
        labels: wk.map(w=>w.label),
        datasets:[
          {label:'Planned', data:wk.map(w=>w.planned), backgroundColor:'#3b82f644', borderColor:'#3b82f6', borderWidth:1},
          {label:'Actual',  data:wk.map(w=>w.actual),  backgroundColor:'#0d9488aa', borderColor:'#0d9488', borderWidth:1},
        ]
      },
      options:{responsive:true, maintainAspectRatio:false,
        plugins:{legend:{labels:{color:'#9ca3af',font:{size:11}}}},
        scales:{x:{ticks:{color:'#6b7280'},grid:{color:'#2e3350'}}, y:{ticks:{color:'#6b7280'},grid:{color:'#2e3350'}}}}
    });
  } else { chWeekly.data.datasets[0].data=wk.map(w=>w.planned); chWeekly.data.datasets[1].data=wk.map(w=>w.actual); chWeekly.update(); }

  // Cumulative line
  if (!chCumul) {
    chCumul = new Chart(document.getElementById('ch-cumul'), {
      type:'line',
      data:{
        labels: wk.map(w=>w.label),
        datasets:[
          {label:'Planned', data:d.cumul.planned, borderColor:'#3b82f6', backgroundColor:'#3b82f622', tension:.4, fill:true},
          {label:'Actual',  data:d.cumul.actual,  borderColor:'#0d9488', backgroundColor:'#0d948822', tension:.4, fill:true},
        ]
      },
      options:{responsive:true, maintainAspectRatio:false,
        plugins:{legend:{labels:{color:'#9ca3af',font:{size:11}}}},
        scales:{x:{ticks:{color:'#6b7280'},grid:{color:'#2e3350'}}, y:{ticks:{color:'#6b7280'},grid:{color:'#2e3350'}}}}
    });
  }

  // By type
  const typeLabels = Object.keys(d.byType);
  const typeData   = Object.values(d.byType);
  if (!chType) {
    chType = new Chart(document.getElementById('ch-type'), {
      type:'bar',
      data:{labels:typeLabels, datasets:[{data:typeData, backgroundColor:['#0d9488','#3b82f6','#a855f7','#f59e0b','#22c55e'], borderWidth:0}]},
      options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
        scales:{x:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'#2e3350'}}, y:{ticks:{color:'#6b7280'},grid:{color:'#2e3350'}}}}
    });
  }
}

// â”€â”€â”€ Element Register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadElements() {
  const els = await tryFetch('/elements', []);
  allElements = els;
  renderElements(els);
}

function filterElements() {
  const q   = document.getElementById('el-search').value.toLowerCase();
  const st  = document.getElementById('el-status').value;
  const blk = document.getElementById('el-block').value;
  const filtered = allElements.filter(e =>
    (!q   || e.id.toLowerCase().includes(q) || e.batch.toLowerCase().includes(q)) &&
    (!st  || e.status === st) &&
    (!blk || e.block === blk)
  );
  renderElements(filtered);
}

function renderElements(els) {
  const tbody = document.getElementById('el-tbody');
  const empty = document.getElementById('el-empty');
  if (els.length === 0) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = els.map(e => {
    const cp = e.checklistProgress;
    const bar = cp.total ? `<div style="display:flex;align-items:center;gap:6px"><div class="progress-bar-wrap"><div class="progress-bar" style="width:${cp.pct}%"></div></div><span style="font-size:11px;color:var(--muted)">${cp.done}/${cp.total}</span></div>` : '<span style="color:var(--muted);font-size:11px">â€”</span>';
    return `<tr class="clickable" data-action="open-element" data-element-id="${escAttr(e.id)}">
      <td><span style="font-family:monospace;font-size:12px;font-weight:600;color:var(--teal-text)">${esc(e.id)}</span></td>
      <td><span class="tag">${esc(e.type)}</span></td>
      <td>${esc(e.block)} Â· ${esc(e.level)}</td>
      <td style="font-family:monospace;font-size:12px">${esc(e.batch)}</td>
      <td>${badge(e.status)}</td>
      <td style="font-size:12px;color:var(--muted)">${e.plannedDate}</td>
      <td>${bar}</td>
      <td>${e.ncrCount > 0 ? `<span style="color:var(--red);font-weight:700">âš  ${e.ncrCount}</span>` : '<span style="color:var(--muted)">â€”</span>'}</td>
    </tr>`;
  }).join('');
}

// â”€â”€â”€ Element Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openElement(id) {
  currentElementId = id;
  nav('detail', null);
  const el = await tryFetch(`/elements/${encodeURIComponent(id)}`, null);
  if (!el) { document.getElementById('detail-content').innerHTML = '<div class="empty">Element not found.</div>'; return; }
  renderDetail(el);
}

const STATUS_STEPS = ['not_started','in_production','pending_qc','qc_passed','ready_delivery','delivered'];

function renderDetail(el) {
  const stepIdx  = STATUS_STEPS.indexOf(el.status);
  const isNCR    = el.status === 'ncr_open';

  const steps = STATUS_STEPS.map((s, i) => {
    let cls = i < (isNCR ? STATUS_STEPS.indexOf('pending_qc') : stepIdx) ? 'done' :
              (el.status === s ? (isNCR && s === 'pending_qc' ? 'ncr' : 'active') : '');
    return `<div class="step ${cls}"><div class="step-dot">${i + 1}</div><span class="step-label">${STATUS_LABELS[s]||s}</span></div>`;
  }).join('');

  const rows = el.checklist.map(item => {
    const passActive = item.result === 'pass'  ? 'active' : '';
    const failActive = item.result === 'fail'  ? 'active' : '';
    const naActive   = item.result === 'na'    ? 'active' : '';
    return `<div class="cl-row" data-id="${escAttr(item.id)}">
      <span class="cl-code">${esc(item.code)}</span>
      <span class="cl-desc">${esc(item.description)}</span>
      <div class="cl-actions">
        <button class="cl-btn pass ${passActive}" data-action="set-check" data-id="${escAttr(el.id)}" data-id2="${escAttr(item.id)}" data-value="pass">âœ“ Pass</button>
        <button class="cl-btn fail ${failActive}" data-action="set-check" data-id="${escAttr(el.id)}" data-id2="${escAttr(item.id)}" data-value="fail">âœ— Fail</button>
        <button class="cl-btn na ${naActive}"   data-action="set-check" data-id="${escAttr(el.id)}" data-id2="${escAttr(item.id)}" data-value="na">N/A</button>
      </div>
      ${item.checkedBy ? `<span class="cl-result ${item.result||''}">${esc((item.result||'').toUpperCase())} Â· ${esc(item.checkedBy)}</span>` : ''}
    </div>`;
  }).join('');

  const ncrCards = el.ncrs.length ? el.ncrs.map(n => `
    <div class="ncr-card">
      <div class="ncr-header">
        <span class="ncr-no">${esc(n.ncrNo)}</span>
        <span class="s-badge ${n.status==='closed'?'s-qc_passed':'s-ncr_open'}">${esc(n.status)}</span>
        <span class="sev-${n.severity}">${esc(n.severity.toUpperCase())}</span>
      </div>
      <div class="ncr-body">${esc(n.description)}</div>
      ${n.location ? `<div class="ncr-meta">ðŸ“ ${esc(n.location)}</div>` : ''}
      <div class="ncr-meta" style="margin-top:4px">Raised by ${esc(n.raisedBy)} Â· ${new Date(n.raisedAt).toLocaleDateString('en-SG')}</div>
      ${n.correctiveAction ? `<div style="font-size:13px;color:var(--green);margin-top:8px">âœ“ Corrective action: ${esc(n.correctiveAction)}</div>` : ''}
      ${n.status !== 'closed' ? `<div style="margin-top:10px"><button class="btn btn-sm btn-secondary" data-action="open-close-ncr" data-id="${escAttr(n.id)}">Close NCR</button></div>` : ''}
    </div>`).join('') : '<div style="color:var(--muted);font-size:13px;padding:8px 0">No NCRs raised for this element.</div>';

  const cp = el.checklist.filter(i => i.result !== null).length;
  const pct = el.checklist.length ? Math.round(cp/el.checklist.length*100) : 0;

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <div class="detail-id">${esc(el.id)}</div>
      <div class="detail-meta">
        <span><strong>${esc(el.type)}</strong></span>
        <span>${esc(el.block)} Â· ${esc(el.level)} Â· ${esc(el.position)}</span>
        <span>Batch: <strong>${esc(el.batch)}</strong></span>
        <span>Grade: <strong>${esc(el.concreteGrade)}</strong></span>
        <span>Weight: <strong>${esc(el.weight)}</strong></span>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" data-action="open-status-modal" data-id="${escAttr(el.id)}" data-value="${escAttr(el.status)}">Update Status</button>
        <button class="btn btn-danger btn-sm" data-action="open-ncr-modal" data-id="${escAttr(el.id)}">âš  Raise NCR</button>
        <button class="btn btn-secondary btn-sm" data-action="show-qr" data-id="${escAttr(el.id)}">â¬› Show QR</button>
      </div>
    </div>

    <div class="section-title">Production Status</div>
    <div class="stepper">${steps}</div>
    ${isNCR ? `<div style="background:#450a0a22;border:1px solid #ef444444;border-radius:8px;padding:12px;margin-bottom:20px;font-size:13px;color:#fca5a5">âš  NCR open â€” element on hold until non-conformance is resolved.</div>` : ''}

    <div class="divider"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div class="section-title" style="margin-bottom:0">QC Inspection Checklist</div>
      <div style="font-size:12px;color:var(--muted)">${cp}/${el.checklist.length} checked Â· ${pct}%</div>
    </div>
    <div class="checklist">${rows}</div>
    <div style="margin-bottom:8px"><button class="btn btn-primary btn-sm" data-action="submit-checklist" data-id="${escAttr(el.id)}">Save Inspection</button></div>

    <div class="divider"></div>
    <div class="section-title">Non-Conformance Reports</div>
    ${ncrCards}

    <div class="divider"></div>
    <div class="section-title">Status History</div>
    <div class="tcard" style="margin-bottom:0">
      <table class="t">
        <thead><tr><th>From</th><th>To</th><th>By</th><th>At</th></tr></thead>
        <tbody>
          ${el.statusHistory.map(h=>`<tr><td>${h.from ? badge(h.from) : 'â€”'}</td><td>${badge(h.to)}</td><td>${esc(h.by)}</td><td style="font-size:12px;color:var(--muted)">${new Date(h.at).toLocaleString('en-SG')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Inline checklist result state (before save)
const pendingChecklist = {};
function setCheckItem(elemId, itemId, result) {
  if (!pendingChecklist[elemId]) pendingChecklist[elemId] = {};
  pendingChecklist[elemId][itemId] = result;
  // Update UI
  const row = document.querySelector(`.cl-row[data-id="${itemId}"]`);
  if (row) {
    row.querySelectorAll('.cl-btn').forEach(b => b.classList.remove('active'));
    const active = row.querySelector(`.cl-btn.${result}`);
    if (active) active.classList.add('active');
  }
}

async function submitChecklist(elemId) {
  const pending = pendingChecklist[elemId];
  if (!pending || Object.keys(pending).length === 0) { toast('No changes to save','error'); return; }
  const items = Object.entries(pending).map(([id, result]) => ({id, result}));
  const r = await apiFetch(`/elements/${encodeURIComponent(elemId)}/checklist`, 'PATCH', {items, checkedBy: currentUser});
  if (r?.ok) {
    delete pendingChecklist[elemId];
    toast('Checklist saved');
    openElement(elemId);
  } else toast('Save failed','error');
}

// â”€â”€â”€ Status modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openStatusModal(id, currentStatus) {
  document.getElementById('sm-elem-id').textContent = id;
  document.getElementById('sm-status').value = currentStatus;
  document.getElementById('sm-by').value = currentUser;
  document.getElementById('status-modal').classList.add('open');
}

async function submitStatusUpdate() {
  const id = document.getElementById('sm-elem-id').textContent;
  const status = document.getElementById('sm-status').value;
  const by = document.getElementById('sm-by').value;
  const r = await apiFetch(`/elements/${encodeURIComponent(id)}/status`, 'PATCH', {status, by});
  if (r?.ok) {
    closeModal('status-modal');
    toast('Status updated to: ' + STATUS_LABELS[status]);
    openElement(id);
  } else toast('Update failed','error');
}

// â”€â”€â”€ NCR modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openNCRModal(id) {
  document.getElementById('nm-elem-id').textContent = id;
  document.getElementById('nm-desc').value = '';
  document.getElementById('nm-loc').value = '';
  document.getElementById('nm-by').value = currentUser;
  document.getElementById('ncr-modal').classList.add('open');
}

async function submitNCR() {
  const id = document.getElementById('nm-elem-id').textContent;
  const r = await apiFetch(`/elements/${encodeURIComponent(id)}/ncrs`, 'POST', {
    description: document.getElementById('nm-desc').value,
    location:    document.getElementById('nm-loc').value,
    severity:    document.getElementById('nm-sev').value,
    raisedBy:    document.getElementById('nm-by').value,
  });
  if (r?.ok) {
    closeModal('ncr-modal');
    toast('NCR raised: ' + r.ncr.ncrNo);
    openElement(id);
    loadDashboard();
  } else toast('Failed to raise NCR','error');
}

function openCloseNCR(ncrId) {
  document.getElementById('cnm-id').value = ncrId;
  document.getElementById('cnm-action').value = '';
  document.getElementById('cnm-by').value = currentUser;
  document.getElementById('close-ncr-modal').classList.add('open');
}

async function submitCloseNCR() {
  const id = document.getElementById('cnm-id').value;
  const r = await apiFetch(`/ncrs/${id}`, 'PATCH', {
    status:'closed',
    correctiveAction: document.getElementById('cnm-action').value,
    closedBy: document.getElementById('cnm-by').value,
  });
  if (r?.ok) {
    closeModal('close-ncr-modal');
    toast('NCR closed successfully');
    openElement(currentElementId);
    loadDashboard();
  } else toast('Close failed','error');
}

// â”€â”€â”€ NCR list view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderNCRs() {
  const filter = document.getElementById('ncr-filter')?.value || '';
  const url = filter ? `/ncrs?status=${filter}` : '/ncrs';
  const ncrs = await tryFetch(url, []);
  const el = document.getElementById('ncr-list');
  if (!ncrs.length) { el.innerHTML = '<div class="empty">No NCRs found.</div>'; return; }
  el.innerHTML = ncrs.map(n => `
    <div class="ncr-card">
      <div class="ncr-header">
        <span class="ncr-no">${esc(n.ncrNo)}</span>
        <span class="s-badge ${n.status==='closed'?'s-qc_passed':'s-ncr_open'}">${esc(n.status.replace('_',' '))}</span>
        <span class="sev-${n.severity}">${esc(n.severity.toUpperCase())}</span>
        <span style="margin-left:auto;font-size:12px;cursor:pointer;color:var(--teal-text)" data-action="open-element" data-id="${escAttr(n.elementId)}">â†’ ${esc(n.elementId)}</span>
      </div>
      <div class="ncr-body">${esc(n.description)}</div>
      <div class="ncr-meta">ðŸ“ ${esc(n.location||'â€”')} Â· Raised by ${esc(n.raisedBy)} Â· ${new Date(n.raisedAt).toLocaleDateString('en-SG')}</div>
      ${n.status !== 'closed' ? `<div style="margin-top:10px"><button class="btn btn-sm btn-secondary" data-action="open-close-ncr" data-id="${escAttr(n.id)}">Close NCR</button></div>` : `<div style="font-size:13px;color:var(--green);margin-top:8px">âœ“ ${esc(n.correctiveAction)}</div>`}
    </div>`).join('');
}

// â”€â”€â”€ QR Codes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderQRCodes() {
  const block = document.getElementById('qr-block')?.value || 'Blk 301A';
  const els   = allElements.filter(e => e.block === block).slice(0, 20);
  if (!els.length) { document.getElementById('qr-grid').innerHTML = '<div class="empty">Load element register first.</div>'; return; }
  document.getElementById('qr-grid').innerHTML = els.map(e => `
    <div class="qr-item">
      <div class="qr-canvas" id="qr-${e.id.replace(/[^a-z0-9]/gi,'_')}"></div>
      <div class="qr-label">${e.id}</div>
      <div class="qr-status">${STATUS_LABELS[e.status]||e.status}</div>
    </div>`).join('');
  els.forEach(e => {
    const containerId = 'qr-' + e.id.replace(/[^a-z0-9]/gi,'_');
    try {
      new QRCode(document.getElementById(containerId), {
        text: e.id, width:120, height:120,
        colorDark:'#000', colorLight:'#fff', correctLevel: QRCode.CorrectLevel.M
      });
    } catch(err) { console.error('QR error', e.id, err); }
  });
}

function showQRFor(id) {
  nav('qrcodes', document.querySelector('.nav-item[data-tab="qrcodes"]'));
  document.getElementById('qr-block').value = allElements.find(e=>e.id===id)?.block || 'Blk 301A';
  renderQRCodes();
}

// â”€â”€â”€ QR Scanner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startScanner() {
  document.getElementById('scan-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'inline-block';
  document.getElementById('scan-result').style.display = 'none';
  scannerInstance = new Html5Qrcode('scanner-region');
  scannerInstance.start(
    { facingMode: 'environment' },
    { fps:10, qrbox:{width:220, height:220} },
    (decodedText) => {
      scannedId = decodedText.trim();
      document.getElementById('scan-id').textContent = scannedId;
      document.getElementById('scan-result').style.display = 'block';
      stopScanner();
    },
    () => {}
  ).catch(err => {
    toast('Camera access denied. Use manual entry below.', 'error');
    stopScanner();
  });
}

function stopScanner() {
  if (scannerInstance) {
    scannerInstance.stop().catch(()=>{});
    scannerInstance = null;
  }
  document.getElementById('scan-btn').style.display = 'inline-block';
  document.getElementById('stop-btn').style.display = 'none';
}

function goToScannedElement() {
  if (scannedId) openElement(scannedId);
}

function goToManualElement() {
  const id = document.getElementById('manual-id').value.trim();
  if (id) openElement(id);
}

// â”€â”€â”€ Modal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if(e.target===m) m.classList.remove('open'); }));

// â”€â”€â”€ Fetch helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function tryFetch(path, fallback) {
  try {
    const r = await fetch(API + path, { headers: authHeaders() });
    if (r.status === 401) { handleUnauthorized(); return fallback; }
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch(e) { console.error('Fetch error', path, e); return fallback; }
}

async function apiFetch(path, method, body) {
  try {
    const r = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(body)
    });
    if (r.status === 401) { handleUnauthorized(); return null; }
    return await r.json();
  } catch(e) { console.error('API error', path, e); return null; }
}

// â”€â”€â”€ Init â€” only after login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (TOKEN) {
  loadDashboard();
  loadElements();
} else {
  showLogin();
}

// â”€â”€â”€ Real-time Socket.io (connects only when logged in) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const socket = io(BASE, { transports: ['websocket','polling'], auth: { token: TOKEN }, autoConnect: !!TOKEN });

// Live indicator
const liveDot   = document.getElementById('live-dot');
const liveLabel = document.getElementById('live-label');

socket.on('connect', () => {
  liveDot.className   = 'live-dot connected';
  liveLabel.textContent = 'â— Live';
  liveLabel.style.color = 'var(--green)';
});
socket.on('disconnect', () => {
  liveDot.className   = 'live-dot disconnected';
  liveLabel.textContent = 'Reconnectingâ€¦';
  liveLabel.style.color = 'var(--muted)';
});
socket.on('connect_error', () => {
  liveDot.className   = 'live-dot disconnected';
  liveLabel.textContent = 'Offline';
  liveLabel.style.color = 'var(--red)';
});
// Server disconnects the socket when it detects a revoked token, deleted account,
// role change, or site reassignment. Clear session and return to login.
socket.on('reauth_required', ({ reason } = {}) => {
  sessionStorage.removeItem('idd_token');
  sessionStorage.removeItem('idd_user');
  showLogin(reason || 'Session expired â€” please log in again');
});

// Activity feed â€” shows events from OTHER users
function showActivity(icon, msg) {
  const feed = document.getElementById('activity-feed');
  const el = document.createElement('div');
  el.className = 'activity-item';
  el.textContent = `${icon} ${msg}`;
  feed.appendChild(el);
  // Fade out after 4s, remove after 4.5s
  setTimeout(() => el.classList.add('fade-out'), 4000);
  setTimeout(() => el.remove(), 4500);
  // Keep max 4 visible
  while (feed.children.length > 4) feed.removeChild(feed.firstChild);
}

// element:updated â€” another user changed a status or checklist
socket.on('element:updated', ({ id, status, by, checklistPct, updatedAt }) => {
  // 1. Update element row in the register table without a full reload
  const row = document.querySelector(`#el-tbody tr[data-element-id="${CSS.escape(id)}"]`);
  if (row) {
    const cells = row.querySelectorAll('td');
    if (cells[4]) cells[4].innerHTML = badge(status);   // status cell
  }

  // 2. Sync in-memory allElements
  const mem = allElements.find(e => e.id === id);
  if (mem) { mem.status = status; mem.updatedAt = updatedAt; }

  // 3. If we're viewing that element's detail, live-refresh it
  const isDetailActive = document.getElementById('tab-detail').classList.contains('active');
  if (isDetailActive && currentElementId === id) {
    openElement(id);   // re-fetch + re-render
  }

  // 4. Activity message (skip if it was this tab that made the change â€” handled by toast)
  showActivity('ðŸ”„', `${id} â†’ ${STATUS_LABELS[status] || status}${by ? ' by ' + by : ''}`);
});

// ncr:raised
socket.on('ncr:raised', ({ ncrNo, elementId, severity, raisedBy }) => {
  const b = document.getElementById('ncr-badge');
  if (b) b.textContent = parseInt(b.textContent || '0') + 1;
  showActivity('âš ï¸', `${ncrNo} raised on ${elementId} [${severity}] by ${raisedBy}`);
  if (document.getElementById('tab-ncrs').classList.contains('active')) renderNCRs();
});

// ncr:updated
socket.on('ncr:updated', ({ ncrNo, status, elementId }) => {
  if (status === 'closed') {
    showActivity('âœ…', `${ncrNo} closed â€” ${elementId} back in queue`);
    const b = document.getElementById('ncr-badge');
    if (b) b.textContent = Math.max(0, parseInt(b.textContent || '0') - 1);
  }
  if (document.getElementById('tab-ncrs').classList.contains('active')) renderNCRs();
});

// dashboard:refresh
socket.on('dashboard:refresh', function() {
  if (document.getElementById('tab-dashboard').classList.contains('active')) loadDashboard();
});

// â”€â”€â”€ Delegated click handling (no inline onclick for dynamic data) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Dynamic IDs (element/NCR/checklist-item ids) are rendered as data-*
// attributes (escAttr()'d) instead of being concatenated into onclick="..."
// strings. A single listener here reads them back via .dataset and calls the
// real handler â€” so even an id containing a quote or backslash can never
// break out of an attribute into new markup or executable script.
document.body.addEventListener('click', e => {
  const t = e.target.closest('[data-action],[data-section],[data-close-modal]');
  if (!t) return;
  const section = t.dataset.section;
  if (section) { e.preventDefault(); nav(section, t); return; }
  const closeModal_ = t.dataset.closeModal;
  if (closeModal_) { closeModal(closeModal_); return; }
  const id = t.dataset.id ?? t.dataset.elementId, id2 = t.dataset.id2, value = t.dataset.value;
  switch (t.dataset.action) {
    case 'open-element':          openElement(id); break;
    case 'set-check':             setCheckItem(id, id2, value); break;
    case 'open-close-ncr':        openCloseNCR(id); break;
    case 'open-status-modal':     openStatusModal(id, value); break;
    case 'open-ncr-modal':        openNCRModal(id); break;
    case 'show-qr':               showQRFor(id); break;
    case 'submit-checklist':      submitChecklist(id); break;
    case 'toggle-sidebar':        document.querySelector('.sidebar').classList.toggle('open'); break;
    case 'logout':                e.preventDefault(); logout(); break;
    case 'start-scanner':         startScanner(); break;
    case 'stop-scanner':          stopScanner(); break;
    case 'goto-scanned':          goToScannedElement(); break;
    case 'goto-manual':           goToManualElement(); break;
    case 'print':                 window.print(); break;
    case 'submit-status':         submitStatusUpdate(); break;
    case 'submit-ncr':            submitNCR(); break;
    case 'submit-close-ncr':      submitCloseNCR(); break;
    case 'nav-elements-specific': nav('elements', document.querySelector('.nav-item:nth-child(5)')); break;
  }
});
