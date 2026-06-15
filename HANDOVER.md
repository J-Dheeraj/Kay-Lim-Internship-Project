# Handover

A short orientation for whoever takes this project over. Detail lives in
[`README.md`](README.md) (features, roles, running) and [`DEPLOY.md`](DEPLOY.md)
(production deployment + operations).

## What this is

Two related prototypes for Kay Lim's IDD / construction digitalisation:

1. **Construction Command Centre** — a dashboard aggregating Autodesk Construction
   Cloud, Power BI, Insight QSE, and UniCon. Live data where vendor credentials
   are configured; clearly-labelled demo data otherwise.
2. **IDD Digital Production** — a precast/PPVC QC tracker (element register, QR
   scanning, inspection checklists, NCR workflow, real-time sync), persisted in
   SQLite.

Two small Node services share authentication. `acc_backend_server.js` (:3001)
serves the Command Centre + its API; `idd_production_server.js` (:3002) serves
the IDD app + its API.

## Current state (verified)

- Everything is on `main`. **GitHub Actions CI** runs the test suite on every
  push and is green.
- **28 automated tests pass**; clean `npm ci`; zero known npm vulnerabilities.
- Independent production-readiness reviews place it at **~7/10 — "Pilot-ready,
  restricted scope."** Good for a controlled internal pilot; **not** yet
  enterprise/production-grade (see "Remaining work").

## Security model (already implemented)

- **Per-user login** — no shared keys. 8-hour signed tokens; `POST /api/logout`
  revokes; deleting a user or changing their role takes effect immediately.
- **RBAC with separation of duties:**

  | Tier | Roles | Access |
  |------|-------|--------|
  | Full access | `head_of_it`, `gm`, `management` | All QC/NCR actions, DB reset, audit verify. GM/Management excluded from manpower. |
  | QC/NCR manager | `pm`, `pd` | Status, checklists, raise + close NCRs |
  | QC inspector | `inspector` | Status, checklists, raise NCRs (not close) |
  | Read-only | `viewer`, `hr` | View everything; HR also **manages manpower** |

- **Audit** is hash-chained and fail-closed (written in the same DB transaction
  as the mutation); reset and manpower changes are audited.
- First run creates a `head_of_it` (IT admin) account from `ADMIN_PASSWORD`.

## How to run

- **Locally (dev):** see the "Run" sections in `README.md` (`npm install`, then
  `npm start` / `npm run start:idd`). Requires Node 20 or 22.
- **Production:** see `DEPLOY.md` — Docker + Caddy with automatic HTTPS. Three
  commands once a host and DNS are ready.

## What the deployer needs to provide

1. **A host with Docker** — a small cloud VPS is recommended and is the simplest
   path to a stable public IP and automatic TLS (`DEPLOY.md` has a host table). A
   home/office PC behind NAT is workable for LAN-only use but a poor public host
   (dynamic IP, router/ISP constraints).
2. **The domain + DNS** — three A-records (`${DOMAIN}`, `cc.${DOMAIN}`,
   `idd.${DOMAIN}`) pointing at the host IP.
3. **Configuration** — copy `.env.deploy.example` to `.env`; set `DOMAIN`,
   generate `SESSION_SECRET` (`openssl rand -hex 32`), set `ADMIN_PASSWORD`, and
   add vendor credentials if available.

Then: `docker compose --env-file .env up -d --build` — HTTPS provisions
automatically once DNS resolves to the host.

## Remaining work (needs credentials, infrastructure, or a decision)

- **Verify live vendor integrations** with real APS / Power BI / Insight QSE /
  UniCon tenant credentials — the code paths exist but are unverified against
  real tenants.
- **Operational maturity** for production: centralised monitoring/alerting,
  scheduled backups + a tested restore, and (for scale/HA) moving off single-host
  SQLite/local files to managed PostgreSQL, an enterprise IdP (SSO/MFA), and
  shared session storage.
- **Frontend polish:** the UI is not yet role-aware (read-only users still see
  action buttons and get a 403 on click — the backend enforces correctly), and
  per-widget data-provenance (live / stale / demo) is not surfaced.

## Reference

- `README.md` — features, full role matrix, running, auth.
- `DEPLOY.md` — deployment & operations runbook (hosts, DNS, backup/restore,
  monitoring, rollback).
- Production-readiness review documents (in the project owner's
  "Kay Lim Internship" folder) — the full independent assessments this work was
  driven by.
