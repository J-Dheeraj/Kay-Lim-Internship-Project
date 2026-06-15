# Kay Lim Internship Project — Construction IT Digitalisation

[![CI](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/J-Dheeraj/Kay-Lim-Internship-Project/actions/workflows/ci.yml)

Two prototypes built during a 2-week IT internship at Kay Lim Construction (Singapore), grounded in the HDB BSS S77 §77.2 Integrated Digital Delivery (IDD) requirements.

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
# open construction_dashboard.html in a browser and log in
```
Falls back to realistic mock data automatically when vendor credentials are not set.

## 2. IDD Digital Production prototype 
Real-time tracker for HDB IDD Use Case #6 (Digital Production): precast/PPVC element register, QR tagging + camera scanner, QC inspection checklists, NCR workflow, live multi-user sync via Socket.io. State is persisted in SQLite (WAL).

### Run
```bash
npm install
npm run start:idd           # serves the app + API on :3002
# open http://localhost:3002/ and log in
```

## Authentication
- **Per-user login** — `POST /api/login` returns a signed session token (8h); the browser sends it as `Authorization: Bearer <token>`. No API key is ever exposed to the browser.
- **Logout / revocation** — `POST /api/logout` revokes the token; deleting a user or changing their role takes effect on their next request.
- **User management** — `node auth.js add-user <name> <password> [viewer|hr|inspector|pm|pd|gm|management|head_of_it]`, `remove-user`, `list-users`. First run creates a `head_of_it` account (password from `ADMIN_PASSWORD`, or printed once).
- **Roles (RBAC)** — four capability tiers, mapped to Kay Lim org positions. Reads are open to any logged-in user; mutations are gated:

  | Tier | Roles | Can do |
  |------|-------|--------|
  | Full access | `head_of_it` (legacy `admin`), `gm`, `management` | Everything: DB reset, audit verification, all QC/NCR actions. **GM/Management get everything *except* the manpower feature** (HR/IT only). |
  | QC/NCR manager | `pd`, `pm` (legacy `supervisor`) | Change status, submit checklists, raise **and close/approve** NCRs |
  | QC inspector | `inspector` (legacy `user`) | Change status, submit checklists, raise NCRs — **cannot close** (separation of duties) |
  | Read-only | `viewer`, `hr` | View dashboards, elements, NCRs |

  Only `head_of_it` (IT) holds the *most* access — it's the one full-access role that **also** manages manpower. **Feature-scoped admin** sits alongside the tiers: `hr` (and `head_of_it`) manage the **manpower** feature (`PUT /api/manpower`); GM/Management are full-access but explicitly excluded from manpower. Other features (projects, QSE, etc.) can be scoped to roles the same way as they gain admin actions.

## Security notes
- Vendor API keys live server-side in `.env` only — never sent to the browser.
- All `/api` routes require a valid token (except health and login); Socket.io connections are authenticated too.
- IDD mutations are recorded in a hash-chained, append-only audit log (`idd_audit.log`).
- User-supplied text is HTML-escaped before rendering; CORS is locked to allowlisted origins.
- TLS: set `TLS_KEY_FILE`/`TLS_CERT_FILE` to serve HTTPS directly, or terminate TLS at a reverse proxy.
- `npm test` runs the auth unit tests.

See the security review history for known remaining gaps (relational storage, operator workflows, live-integration verification).
