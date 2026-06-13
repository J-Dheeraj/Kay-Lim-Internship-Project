/**
 * IDD relational store (better-sqlite3, WAL).
 *
 * Replaces the previous "whole dataset as one JSON blob" model. State lives in
 * relational, indexed tables and every mutation is a row-level transaction, so:
 *   - a write touches only the affected rows (no full-dataset rewrite),
 *   - there is no in-memory copy of the dataset to drift or clobber, and
 *   - concurrent writers are serialised by SQLite transactions.
 *
 * Tables:
 *   elements(id PK, seq, status, block, type, actualProductionDate, doc, updatedAt)
 *       doc = the element JSON minus its NCRs (scalars + checklist + statusHistory)
 *   ncrs(id PK, elementId, ncrNo, description, severity, location, raisedBy,
 *        raisedAt, status, correctiveAction, closedBy, closedAt, photos)
 *   meta(key PK, value)            ncrCounter | weeklyPlanned | lastUpdated
 *
 * An element returned by the store always has its `.ncrs` array reconstructed
 * from the ncrs table, so route handlers keep operating on the same shape.
 */
import Database from 'better-sqlite3';

export function createStore(dbFile) {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS elements (
      id     TEXT PRIMARY KEY,
      seq    INTEGER,
      status TEXT,
      block  TEXT,
      type   TEXT,
      actualProductionDate TEXT,
      doc    TEXT NOT NULL,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_elements_status ON elements(status);
    CREATE INDEX IF NOT EXISTS idx_elements_block  ON elements(block);
    CREATE INDEX IF NOT EXISTS idx_elements_type   ON elements(type);
    CREATE TABLE IF NOT EXISTS ncrs (
      id     TEXT PRIMARY KEY,
      elementId TEXT NOT NULL,
      ncrNo  TEXT, description TEXT, severity TEXT, location TEXT,
      raisedBy TEXT, raisedAt TEXT,
      status TEXT, correctiveAction TEXT, closedBy TEXT, closedAt TEXT,
      photos TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ncrs_status  ON ncrs(status);
    CREATE INDEX IF NOT EXISTS idx_ncrs_element ON ncrs(elementId);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  // ─── prepared statements ───────────────────────────────────────────────────
  const sUpsertEl = db.prepare(`
    INSERT INTO elements (id, seq, status, block, type, actualProductionDate, doc, updatedAt)
    VALUES (@id, @seq, @status, @block, @type, @actualProductionDate, @doc, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      seq=excluded.seq, status=excluded.status, block=excluded.block, type=excluded.type,
      actualProductionDate=excluded.actualProductionDate, doc=excluded.doc, updatedAt=excluded.updatedAt`);
  const sGetEl       = db.prepare('SELECT doc FROM elements WHERE id = ?');
  const sDelElNcrs   = db.prepare('DELETE FROM ncrs WHERE elementId = ?');
  const sInsNcr      = db.prepare(`
    INSERT INTO ncrs (id, elementId, ncrNo, description, severity, location, raisedBy,
                      raisedAt, status, correctiveAction, closedBy, closedAt, photos)
    VALUES (@id, @elementId, @ncrNo, @description, @severity, @location, @raisedBy,
            @raisedAt, @status, @correctiveAction, @closedBy, @closedAt, @photos)`);
  const sGetNcr      = db.prepare('SELECT elementId FROM ncrs WHERE id = ?');
  const sNcrsByEl    = db.prepare('SELECT * FROM ncrs WHERE elementId = ? ORDER BY raisedAt');
  const sMetaGet     = db.prepare('SELECT value FROM meta WHERE key = ?');
  const sMetaSet     = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

  const ncrRowToObj = r => ({
    id: r.id, elementId: r.elementId, ncrNo: r.ncrNo, description: r.description,
    severity: r.severity, location: r.location, raisedBy: r.raisedBy, raisedAt: r.raisedAt,
    status: r.status, correctiveAction: r.correctiveAction, closedBy: r.closedBy,
    closedAt: r.closedAt, photos: r.photos ? JSON.parse(r.photos) : [],
  });
  const metaGet = (k, dflt) => { const r = sMetaGet.get(k); return r ? JSON.parse(r.value) : dflt; };
  const metaSet = (k, v) => sMetaSet.run(k, JSON.stringify(v));

  // Reconstruct a full element (doc + its NCRs from the ncrs table).
  function getElement(id) {
    const row = sGetEl.get(id);
    if (!row) return null;
    const el = JSON.parse(row.doc);
    el.ncrs = sNcrsByEl.all(id).map(ncrRowToObj);
    return el;
  }

  // Persist an element: upsert its row + replace its NCR rows, atomically.
  function persistElement(el) {
    const { ncrs = [], ...doc } = el;
    sUpsertEl.run({
      id: el.id, seq: el.seq, status: el.status, block: el.block, type: el.type,
      actualProductionDate: el.actualProductionDate ?? null,
      doc: JSON.stringify(doc), updatedAt: el.updatedAt ?? new Date().toISOString(),
    });
    sDelElNcrs.run(el.id);
    for (const n of ncrs) sInsNcr.run({ ...n, photos: JSON.stringify(n.photos || []) });
    metaSet('lastUpdated', new Date().toISOString());
  }

  const NOT_FOUND = Symbol('not_found');

  // Run fn(el, ctx) inside a transaction and persist the mutated element.
  // ctx.nextNcrNo() atomically increments the NCR counter within the same tx.
  function withElement(id, fn) {
    return db.transaction(() => {
      const el = getElement(id);
      if (!el) return NOT_FOUND;
      const ctx = {
        nextNcrNo() {
          const n = (metaGet('ncrCounter', 0)) + 1;
          metaSet('ncrCounter', n);
          return `NCR-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
        },
      };
      const value = fn(el, ctx);
      persistElement(el);
      return value;
    })();
  }

  // Run fn(el, ncr) for the element owning ncrId; persist the element.
  function withNcr(ncrId, fn) {
    return db.transaction(() => {
      const ref = sGetNcr.get(ncrId);
      if (!ref) return NOT_FOUND;
      const el = getElement(ref.elementId);
      const ncr = el.ncrs.find(n => n.id === ncrId);
      const value = fn(el, ncr);
      persistElement(el);
      return value;
    })();
  }

  function listElements({ status, block, type, q } = {}) {
    const where = [], params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (block)  { where.push('block = ?');  params.push(block); }
    if (type)   { where.push('type = ?');   params.push(type); }
    const sql = 'SELECT doc FROM elements' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq';
    const ncrCounts = {};
    for (const r of db.prepare('SELECT elementId, COUNT(*) c FROM ncrs GROUP BY elementId').all())
      ncrCounts[r.elementId] = r.c;
    let rows = db.prepare(sql).all(...params).map(r => JSON.parse(r.doc));
    if (q) {
      const lq = String(q).toLowerCase();
      rows = rows.filter(e => e.id.toLowerCase().includes(lq) || (e.batch || '').toLowerCase().includes(lq));
    }
    return rows.map(e => ({
      id: e.id, seq: e.seq, type: e.type, block: e.block, level: e.level,
      position: e.position, batch: e.batch, status: e.status,
      plannedDate: e.plannedDate, actualProductionDate: e.actualProductionDate,
      ncrCount: ncrCounts[e.id] || 0,
      checklistProgress: checklistProgress(e.checklist),
    }));
  }

  function listNcrs(status) {
    return (status
      ? db.prepare('SELECT * FROM ncrs WHERE status = ? ORDER BY raisedAt').all(status)
      : db.prepare('SELECT * FROM ncrs ORDER BY raisedAt').all()
    ).map(ncrRowToObj);
  }

  // Aggregates for the dashboard — computed in SQL, not by scanning JS arrays.
  function dashboardRaw() {
    const statusCounts = {}, typeCounts = {};
    for (const r of db.prepare('SELECT status, COUNT(*) c FROM elements GROUP BY status').all())
      statusCounts[r.status] = r.c;
    for (const r of db.prepare('SELECT type, COUNT(*) c FROM elements GROUP BY type').all())
      typeCounts[r.type] = r.c;
    const total = db.prepare('SELECT COUNT(*) c FROM elements').get().c;
    const actualDates = db.prepare(
      'SELECT actualProductionDate d FROM elements WHERE actualProductionDate IS NOT NULL').all().map(r => r.d);
    const ncrByStatus = {};
    for (const r of db.prepare('SELECT status, COUNT(*) c FROM ncrs GROUP BY status').all())
      ncrByStatus[r.status] = r.c;
    return {
      statusCounts, typeCounts, total, actualDates,
      openNCRs: ncrByStatus.open || 0, closedNCRs: ncrByStatus.closed || 0,
      weeklyPlanned: metaGet('weeklyPlanned', []),
      lastUpdated: metaGet('lastUpdated', null),
    };
  }

  function isEmpty() { return db.prepare('SELECT COUNT(*) c FROM elements').get().c === 0; }
  function counts() {
    return {
      elements: db.prepare('SELECT COUNT(*) c FROM elements').get().c,
      ncrs: db.prepare('SELECT COUNT(*) c FROM ncrs').get().c,
    };
  }

  // Full snapshot (for backups before a reset).
  function exportAll() {
    const ids = db.prepare('SELECT id FROM elements ORDER BY seq').all().map(r => r.id);
    return { elements: ids.map(getElement), exportedAt: new Date().toISOString() };
  }

  // Migrate from the interim "single JSON blob in a kv table" format, if any,
  // so upgrading does not silently discard existing data. Returns true if done.
  function migrateLegacyBlob() {
    const hasKv = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get();
    if (!hasKv || !isEmpty()) return false;
    const row = db.prepare("SELECT value FROM kv WHERE key='db'").get();
    if (!row) return false;
    const old = JSON.parse(row.value);
    seed(old.elements || [], old.meta?.weeklyPlanned || []);
    return true;
  }

  // Replace all data with a freshly seeded dataset, atomically.
  function seed(elements, weeklyPlanned) {
    db.transaction(() => {
      db.exec('DELETE FROM ncrs; DELETE FROM elements;');
      let ncrCount = 0;
      for (const el of elements) { persistElement(el); ncrCount += (el.ncrs || []).length; }
      metaSet('ncrCounter', ncrCount);
      metaSet('weeklyPlanned', weeklyPlanned);
      metaSet('lastUpdated', new Date().toISOString());
    })();
  }

  return { getElement, withElement, withNcr, listElements, listNcrs,
           dashboardRaw, isEmpty, counts, exportAll, migrateLegacyBlob, seed, NOT_FOUND };
}

export function checklistProgress(checklist) {
  if (!checklist || checklist.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = checklist.filter(i => i.result !== null).length;
  return { done, total: checklist.length, pct: Math.round((done / checklist.length) * 100) };
}
