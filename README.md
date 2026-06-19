# Kay Lim Construction — IT Digitalisation

[![CI](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml)

A construction-industry digitalisation platform built during a 2-week IT internship at Kay Lim Construction (Singapore). Covers HDB BSS S77 §77.2 Integrated Digital Delivery (IDD) use cases 3–6: Digital Production, Logistics, QSE, and Command Centre.

---

## What it does

| App | URL | What it covers |
|-----|-----|----------------|
| **Command Centre** | `/` | Live ACC issues/RFIs/defects, Power BI reports, QSE safety, UniCon projects/tasks/budget, manpower headcount |
| **IDD Digital Production** | `/idd` | Precast/PPVC element register, QR scanning, QC checklists, NCR workflow, real-time multi-user sync |

Both apps run from a single `server.js` process on port 3001. No separate servers, no cross-origin complexity.

---

## Quick start

```bash
# Prerequisites: Node 20 LTS or 22 LTS
npm install
cp .env.deploy.example .env     # fill in ADMIN_PASSWORD (required) + vendor creds (optional)
npm start                        # http://localhost:3001
```

- Command Centre: `http://localhost:3001/`
- IDD Production: `http://localhost:3001/idd`
- Dev (auto-restart on save): `npm run dev`

Vendor credentials are optional — the server falls back to realistic mock data for any integration that is not configured.

**First run:** the admin account is created automatically. The password is read from `ADMIN_PASSWORD` in `.env`, or generated and printed once to the console.

---

## Integrations

| Integration | Status | Env vars needed |
|-------------|--------|-----------------|
| Autodesk Construction Cloud (ACC) — Issues, RFIs, defects, QC checklists | Live | `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `ACC_ACCOUNT_ID`, `ACC_PROJECT_ID` |
| Power BI Embedded — reports via service-principal | Live | `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET`, `PBI_WORKSPACE_ID` |
| IDD Digital Production — SQLite + Socket.io real-time | Live | — (local, no creds needed) |
| Insight QSE (CAPPS) — safety, PTW, NCRs, attendance | Mock | `QSE_BASE_URL`, `QSE_API_KEY` (contact CAPPS: contact@capps.com.sg) |
| UniCon — projects, tasks, budget | Mock | `UNICON_BASE_URL`, `UNICON_API_KEY`, `UNICON_COMPANY_ID` |

---

## Project structure

```
server.js                    Unified backend — Express + Socket.io, port 3001
auth.js                      Authentication: signed tokens, RBAC, revocation, user CLI
idd_store.js                 IDD data layer: SQLite (WAL), hash-chained audit
config-schema.js             Startup config validation
logger.js                    Structured JSON request logger

construction_dashboard.html  Command Centre SPA
construction_dashboard.js
construction_dashboard.css

idd_production_app.html      IDD Production SPA
idd_production_app.js
idd_production_app.css

nav.js / nav.css             Shared hub navigation bar (injected into both apps)

test/
  auth.test.js               Token signing, revocation, RBAC unit tests
  store.test.js              IDD store: CRUD, audit chain, site scoping
  security_headers.test.js   CSP header checks on both app routes
  socket.test.js             Socket.io site-isolation (no cross-site leaks)
  powerbi_allowlist.test.js  Power BI report allow-list enforcement
  smoke.spec.js              Playwright end-to-end: login, navigation, CSP

Dockerfile                   Single container image (Node 22 bookworm-slim, non-root)
docker-compose.yml           One app service + Caddy reverse proxy
Caddyfile                    Auto-TLS, HSTS, idd.DOMAIN → /idd path rewrite
.env.deploy.example          Environment variable reference
.github/workflows/ci.yml     CI: syntax, unit tests, Playwright, Gitleaks, Trivy, SBOM

DEPLOY.md                    Deployment and operations runbook
HANDOVER.md                  Orientation for the next engineer
```

Legacy entry points `acc_backend_server.js` and `idd_production_server.js` are retained for reference only and are not used.

---

## Authentication

All API routes (except `/api/health` and `/api/login`) require a valid `Authorization: Bearer <token>` header. Socket.io connections are authenticated the same way.

**User management (CLI):**
```bash
node auth.js add-user <name> <password> <role> [site]
node auth.js remove-user <name>
node auth.js list-users
node auth.js compact-revoked     # prune expired revocation records
```

**Roles:**

| Tier | Roles | Permissions |
|------|-------|-------------|
| Full access | `head_of_it`, `gm`, `management` | Everything — DB reset, audit verify, all QC/NCR actions. `head_of_it` also manages manpower; `gm`/`management` do not. |
| QC/NCR manager | `pm`, `pd` | Change status, submit checklists, raise and close/approve NCRs |
| QC inspector | `inspector` | Change status, submit checklists, raise NCRs (cannot close — separation of duties) |
| Read-only | `viewer`, `hr` | View dashboards, elements, NCRs. `hr` manages manpower writes. |

**Site scoping:** each IDD element and NCR belongs to a site. Users assigned a site see only that site's data. HQ roles (`head_of_it`, `gm`, `management`) see all sites and receive a `bySite` rollup.

---

## Testing

```bash
npm test          # all unit + integration tests (Node test runner, no extra setup)
npm run smoke     # Playwright end-to-end browser tests (requires Chromium)
```

CI runs on every push: Node 20 + 22 matrix, Playwright smoke, Gitleaks secret scan, Trivy CVE scan, CycloneDX SBOM generation.

---

## Deployment

One command once DNS A/AAAA records point at the host:

```bash
cp .env.deploy.example .env   # fill in DOMAIN, SESSION_SECRET, ADMIN_PASSWORD + vendor creds
docker compose up -d --build
```

Caddy provisions Let's Encrypt TLS automatically and routes:
- `https://DOMAIN` and `https://cc.DOMAIN` → Command Centre
- `https://idd.DOMAIN` → IDD Production (path-rewritten to `/idd` on the unified server)

See `DEPLOY.md` for the full operations runbook including GCP setup, user management, backup/restore, and monitoring.

---

## Security

- **No secrets in the browser** — vendor API keys stay in `.env` and are never forwarded to the client.
- **Explicit static routes** — only named client files are served; the repository root is not exposed via `express.static`.
- **Content Security Policy** — `style-src 'self'`, `script-src 'self'` + pinned CDN hashes; no `unsafe-inline`.
- **Rate limiting** — mutation routes (IDD and UniCon) are rate-limited. Proxy routes (ACC, Power BI, QSE) have a separate limiter.
- **Audit trail** — IDD mutations are stored in a hash-chained SQLite table, verifiable via `GET /api/production/audit/verify`. UniCon mutations are logged with actor and IP.
- **Token revocation** — `POST /api/logout` revokes the token immediately; expired revocation records are pruned hourly.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drains in-flight requests and closes all database handles before exit.
- **Health check** — `GET /api/health` reports identity, IDD, UniCon, and manpower DB status; returns `503` if any check fails.
- **Container** — non-root `node` user, digest-pinned base images, no secrets baked into the image.

Known gaps (pilot-appropriate; not production-ready): local identity instead of enterprise SSO/MFA, SQLite instead of managed PostgreSQL, no central observability or automated recovery.
