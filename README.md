# Kay Lim Internship Project — Construction IT Digitalisation

[![CI](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml)

Two prototypes built during a 2-week IT internship at Kay Lim Construction (Singapore), grounded in the HDB BSS S77 §77.2 Integrated Digital Delivery (IDD) requirements.

## Project structure

| File | What it is |
|------|------------|
| `acc_backend_server.js` | **Command Centre backend** (Express, :3001). Proxies Autodesk ACC / Power BI / QSE / UniCon (credentials stay server-side); serves the Command Centre page; HR-managed manpower (SQLite). |
| `construction_dashboard.html` | **Command Centre** single-page dashboard (served by the ACC backend). |
| `idd_production_server.js` | **IDD Production backend** (Express + Socket.io, :3002). Element/checklist/NCR APIs, real-time sync, site scoping, audit. |
| `idd_production_app.html` | **IDD Production** single-page app (served by the IDD backend). |
| `idd_store.js` | IDD **data layer** — relational SQLite store (elements, NCRs, meta, audit) with row-level transactions and the hash-chained audit. |
| `auth.js` | **Authentication & access control** — login, signed tokens, revocation, RBAC tiers, feature-scoped admin, site scoping, user-management CLI. |
| `nav.js` / `nav.css` | **IDD Hub nav bar** — injected into both apps; links all built QWC1 use cases with automatic URL derivation (no config needed). |
| `test/` | Automated tests (`npm test`, run by CI on every push). |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.deploy.example` | **Deployment** — containers + Caddy reverse proxy with automatic HTTPS. |
| `.github/workflows/ci.yml` | GitHub Actions CI (install, syntax, tests). |
| `README.md` · `DEPLOY.md` · `HANDOVER.md` | This file · deployment/operations runbook (incl. Google Cloud steps) · handover orientation. |

## 1. Construction Command Centre
A single dashboard aggregating four platforms Kay Lim already uses:
- **Autodesk Construction Cloud (ACC)** — Issues/RFIs, defects, quality checklists (live via APS API)
- **Insight QSE (CAPPS)** — safety inspections, PTW, non-conformities, attendance (mock until API key obtained)
- **UniCon** — projects, tasks, budget (mock until API access granted)
- **Power BI** — embedded reports via service-principal auth

### Run
```bash
npm install                 # requires Node 20 LTS or 22 LTS (see .nvmrc)
cp .env.example .env        # set ADMIN_PASSWORD, and APS / Power BI creds if available
npm start                   # backend proxy on :3001
# open http://localhost:3001/ in a browser and log in
```
Falls back to realistic mock data automatically when vendor credentials are not set.

## 2. IDD Digital Production prototype
Real-time tracker for HDB IDD Use Case #3 (Digital Production): precast/PPVC element register, QR tagging + camera scanner, QC inspection checklists, NCR workflow, live multi-user sync via Socket.io. State is persisted in SQLite (WAL).

### Run
```bash
npm install
npm run start:idd           # serves the app + API on :3002
# open http://localhost:3002/ and log in
```

## 3. IDD Hub — cross-app navigation
`nav.js` and `nav.css` are dropped into both apps and inject a persistent sidebar section linking all built QWC1 use cases:

| Entry | UC | Status |
|-------|----|--------|
| Command Centre | UC 3–6 | Live (ACC); mock (QSE, UniCon) |
| Digital Production | UC 3 | Live |
| Digital Logistics | UC 4 | Mock |
| QSE Inspection | UC 6 | Mock |

URL derivation is automatic — no config required:
- Dev: `localhost:3001` ↔ `localhost:3002`
- Production: `domain.com` ↔ `idd.domain.com`

Styles are in `nav.css` (served as a static file) to comply with the `style-src 'self'` Content Security Policy — no inline styles or `unsafe-inline` required.

## Authentication
- **Per-user login** — `POST /api/login` returns a signed session token (8h); the browser sends it as `Authorization: Bearer <token>`. No API key is ever exposed to the browser.
- **Logout / revocation** — `POST /api/logout` revokes the token; deleting a user or changing their role takes effect on their next request.
- **Token compaction** — expired revocation records are purged from SQLite at startup and hourly, keeping the revocations table small.
- **User management** — `node auth.js add-user <name> <password> [viewer|hr|inspector|pm|pd|gm|management|head_of_it] [site]`, `remove-user`, `list-users`. First run creates a `head_of_it` account (password from `ADMIN_PASSWORD`, or printed once). The optional `[site]` scopes a non-HQ user to one site.
- **Roles (RBAC)** — four capability tiers, mapped to Kay Lim org positions. Reads are open to any logged-in user; mutations are gated:

  | Tier | Roles | Can do |
  |------|-------|--------|
  | Full access | `head_of_it` (legacy `admin`), `gm`, `management` | Everything: DB reset, audit verification, all QC/NCR actions. **GM/Management get everything *except* the manpower feature** (HR/IT only). |
  | QC/NCR manager | `pd`, `pm` (legacy `supervisor`) | Change status, submit checklists, raise **and close/approve** NCRs |
  | QC inspector | `inspector` (legacy `user`) | Change status, submit checklists, raise NCRs — **cannot close** (separation of duties) |
  | Read-only | `viewer`, `hr` | View dashboards, elements, NCRs |

  Only `head_of_it` (IT) holds the *most* access — it's the one full-access role that **also** manages manpower. **Feature-scoped admin** sits alongside the tiers: `hr` (and `head_of_it`) manage the **manpower** feature (`PUT /api/manpower`); GM/Management are full-access but explicitly excluded from manpower.

- **Multi-site** — every IDD element/NCR belongs to a **site**. A user assigned a site (`add-user … <role> <site>`) sees and acts on **only that site**; HQ roles (`head_of_it`, `gm`, `management`) see **all sites** and get a per-site rollup on the dashboard (`bySite`). HQ can narrow to one site with `?site=<id>`. `GET /api/production/sites` lists the sites visible to the caller. This is one central deployment serving all sites — see `DEPLOY.md`.

## Security notes
- Vendor API keys live server-side in `.env` only — never sent to the browser.
- All `/api` routes require a valid token (except health and login); Socket.io connections are authenticated too.
- IDD mutations are recorded in a hash-chained SQLite audit table (verified via `GET /api/production/audit/verify`).
- User-supplied text is HTML-escaped before rendering; CORS is locked to allowlisted origins.
- CSP is enforced on both servers (`style-src 'self'`, `script-src 'self'` + pinned CDN hashes); `nav.css` is the external stylesheet that makes the hub nav bar CSP-compliant.
- TLS: set `TLS_KEY_FILE`/`TLS_CERT_FILE` to serve HTTPS directly, or terminate TLS at a reverse proxy. The Caddy image is digest-pinned in `docker-compose.yml`.
- Both servers handle `SIGTERM`/`SIGINT` with a graceful shutdown (drains in-flight requests, closes DB, forced exit after 10 s).
- `GET /api/health` returns `200 ok` when all dependencies are healthy, `503 degraded` with a `checks` breakdown when not — suitable for load-balancer health probes.
- `npm test` runs the auth unit tests and Playwright smoke tests.

See the security review history for known remaining gaps (relational storage, operator workflows, live-integration verification).
