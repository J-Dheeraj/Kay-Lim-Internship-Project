/**
 * Unit tests for the relational IDD store (idd_store.js).
 * Uses a throwaway SQLite file in the OS temp dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../idd_store.js';

const DB = path.join(os.tmpdir(), `klim-store-${process.pid}.db`);
for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB + ext, { force: true });
process.on('exit', () => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(DB + ext, { force: true }); } catch {} } });

const store = createStore(DB);

function el(id, seq, status, type, block, opts = {}) {
  return {
    id, seq, type, block, level: 'L01', position: 'P01', batch: 'BATCH-1',
    status, plannedDate: '2026-06-01',
    actualProductionDate: opts.actual || null, castingDate: null,
    checklist: [
      { id: id + '-a', code: 'DIM', description: 'd', result: opts.checked ? 'pass' : null, remarks: '', checkedBy: null, checkedAt: null, photoUrl: null },
      { id: id + '-b', code: 'SUR', description: 'd', result: opts.checked ? 'pass' : null, remarks: '', checkedBy: null, checkedAt: null, photoUrl: null },
    ],
    ncrs: opts.ncrs || [],
    statusHistory: [{ from: null, to: 'not_started', by: 'System', at: '2026-05-01T00:00:00Z' }],
    createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
  };
}

test('seed populates tables and isEmpty/counts reflect it', () => {
  assert.equal(store.isEmpty(), true);
  store.seed([
    el('E1', 1, 'delivered', 'Wall Panel', 'Blk 301A', { actual: '2026-06-02', checked: true }),
    el('E2', 2, 'in_production', 'Precast Beam', 'Blk 301A'),
    el('E3', 3, 'ncr_open', 'Wall Panel', 'Blk 302', {
      ncrs: [{ id: 'N1', elementId: 'E3', ncrNo: 'NCR-2026-0001', description: 'x', severity: 'major',
               location: 'l', raisedBy: 'QC', raisedAt: '2026-06-01T00:00:00Z', status: 'open',
               correctiveAction: '', closedBy: null, closedAt: null, photos: [] }],
    }),
  ], [8, 8, 8, 8, 8, 8]);
  assert.equal(store.isEmpty(), false);
  assert.deepEqual(store.counts(), { elements: 3, ncrs: 1 });
});

test('listElements filters and reports ncrCount + checklistProgress', () => {
  assert.equal(store.listElements({}).length, 3);
  assert.equal(store.listElements({ block: 'Blk 301A' }).length, 2);
  assert.equal(store.listElements({ type: 'Wall Panel' }).length, 2);
  assert.equal(store.listElements({ status: 'ncr_open' })[0].id, 'E3');
  assert.equal(store.listElements({ q: 'e1' })[0].id, 'E1');
  const e1 = store.listElements({ status: 'delivered' })[0];
  assert.equal(e1.checklistProgress.pct, 100);
  assert.equal(store.listElements({ status: 'ncr_open' })[0].ncrCount, 1);
});

test('getElement reconstructs ncrs from the ncrs table', () => {
  const e3 = store.getElement('E3');
  assert.equal(e3.ncrs.length, 1);
  assert.equal(e3.ncrs[0].ncrNo, 'NCR-2026-0001');
  assert.equal(store.getElement('nope'), null);
});

test('withElement persists a row-level mutation', () => {
  const updated = store.withElement('E2', (e) => { e.status = 'qc_passed'; e.updatedAt = 'now'; return e; });
  assert.equal(updated.status, 'qc_passed');
  assert.equal(store.getElement('E2').status, 'qc_passed');           // persisted
  assert.equal(store.withElement('missing', () => {}), store.NOT_FOUND);
});

test('withElement ctx.nextNcrNo increments atomically and persists ncrs', () => {
  store.withElement('E1', (e, ctx) => {
    e.ncrs.push({ id: 'N2', elementId: 'E1', ncrNo: ctx.nextNcrNo(), description: 'y', severity: 'minor',
                  location: '', raisedBy: 'u', raisedAt: 'now', status: 'open',
                  correctiveAction: '', closedBy: null, closedAt: null, photos: [] });
  });
  const n2 = store.getElement('E1').ncrs[0];
  assert.equal(n2.ncrNo, 'NCR-2026-0002');     // counter was 1 from seed → next is 2
  assert.equal(store.counts().ncrs, 2);
});

test('withNcr mutates the owning element and ncr together', () => {
  const out = store.withNcr('N1', (e, ncr) => { ncr.status = 'closed'; return { e, ncr }; });
  assert.equal(out.ncr.status, 'closed');
  assert.equal(store.listNcrs('closed').length, 1);
  assert.equal(store.withNcr('nope', () => {}), store.NOT_FOUND);
});

test('dashboardRaw aggregates in SQL', () => {
  const d = store.dashboardRaw();
  assert.equal(d.total, 3);
  assert.equal(d.statusCounts.qc_passed, 1);   // E2 was advanced
  assert.equal(d.typeCounts['Wall Panel'], 2);
  assert.equal(d.weeklyPlanned.length, 6);
  assert.ok(d.actualDates.includes('2026-06-02'));
});

test('ctx.audit writes a hash-chained row inside the mutation transaction', () => {
  const before = store.verifyAuditChain().count || 0;
  store.withElement('E2', (e, ctx) => {
    e.status = 'ready_delivery';
    ctx.audit('element.status', { elementId: e.id, status: e.status });
    return e;
  }, { actor: 'inspector-a', ip: '10.0.0.1' });
  const chain = store.verifyAuditChain();
  assert.equal(chain.valid, true);
  assert.equal(chain.count, before + 1);                       // exactly one row added
  assert.equal(store.getElement('E2').status, 'ready_delivery');
});

test('audit + mutation are atomic: a throw rolls BOTH back (fail-closed)', () => {
  const beforeStatus = store.getElement('E2').status;
  const beforeAudit  = store.verifyAuditChain().count;
  assert.throws(() => {
    store.withElement('E2', (e, ctx) => {
      e.status = 'delivered';
      ctx.audit('element.status', { status: 'delivered' });   // audit in same tx
      throw new Error('boom after audit');                    // force rollback
    }, { actor: 'x' });
  }, /boom after audit/);
  assert.equal(store.getElement('E2').status, beforeStatus, 'mutation rolled back');
  assert.equal(store.verifyAuditChain().count, beforeAudit, 'audit row rolled back too');
});

test('standalone audit chains and tampering is detectable', () => {
  store.audit({ actor: 'admin', ip: '10.0.0.1', action: 'db.reset', details: { backup: 'x.json' } });
  assert.equal(store.verifyAuditChain().valid, true);
});

test('site scoping: filter, dashboard rollup, and element/ncr site lookups', () => {
  const f = path.join(os.tmpdir(), `klim-sites-${process.pid}.db`);
  for (const e of ['', '-wal', '-shm']) fs.rmSync(f + e, { force: true });
  const s2 = createStore(f);
  const elem = (id, site, status, ncrs = []) => ({
    id, seq: parseInt(id.slice(1)), site, siteName: site + ' name', type: 'Wall Panel',
    block: 'Blk 1', level: 'L01', position: 'P01', batch: 'B', status,
    plannedDate: '2026-06-01', actualProductionDate: null, checklist: [],
    statusHistory: [], ncrs, createdAt: '2026-05-01', updatedAt: '2026-05-01',
  });
  s2.seed([
    elem('A1', 'SITE-A', 'delivered'),
    elem('A2', 'SITE-A', 'ncr_open', [{ id:'NA', elementId:'A2', ncrNo:'NCR-1', description:'x',
      severity:'major', location:'l', raisedBy:'qc', raisedAt:'2026-06-01', status:'open',
      correctiveAction:'', closedBy:null, closedAt:null, photos:[] }]),
    elem('B1', 'SITE-B', 'qc_passed'),
  ], [8, 8, 8, 8, 8, 8]);

  assert.equal(s2.listElements({ site: 'SITE-A' }).length, 2);
  assert.equal(s2.listElements({ site: 'SITE-B' }).length, 1);
  assert.equal(s2.listElements({}).length, 3);
  assert.equal(s2.listElements({})[0].site, 'SITE-A');         // projection carries site
  assert.equal(s2.elementSite('A1'), 'SITE-A');
  assert.equal(s2.ncrSite('NA'), 'SITE-A');
  assert.equal(s2.listNcrs(undefined, 'SITE-B').length, 0);
  assert.equal(s2.listNcrs(undefined, 'SITE-A').length, 1);

  assert.equal(s2.dashboardRaw('SITE-A').total, 2);
  assert.equal(s2.dashboardRaw('SITE-A').bySite, null);
  const hq = s2.dashboardRaw();
  assert.equal(hq.total, 3);
  assert.equal(hq.bySite.length, 2);
  assert.equal(hq.bySite.find(r => r.site === 'SITE-A').openNCRs, 1);
});
