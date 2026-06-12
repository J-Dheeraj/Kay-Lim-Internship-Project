# Kay Lim Internship Project — Construction IT Digitalisation

Two prototypes built during a 2-week IT internship at Kay Lim Construction (Singapore), grounded in the HDB BSS S77 §77.2 Integrated Digital Delivery (IDD) requirements.

## 1. Construction Command Centre 
A single dashboard aggregating four platforms Kay Lim already uses:
- **Autodesk Construction Cloud (ACC)** — Issues/RFIs, defects, quality checklists (live via APS API)
- **Insight QSE (CAPPS)** — safety inspections, PTW, non-conformities, attendance (mock until API key obtained)
- **UniCon** — projects, tasks, budget (mock until API access granted)
- **Power BI** — embedded reports via service-principal auth

### Run
```bash

npm install
cp .env.example .env   # fill in APS / Power BI credentials
node acc_backend_server.js          # backend proxy on :3001
# open construction_dashboard.html in a browser
```
Falls back to realistic mock data automatically when credentials are not set.

## 2. IDD Digital Production prototype 
Real-time tracker for HDB IDD Use Case #6 (Digital Production): precast/PPVC element register, QR tagging + camera scanner, QC inspection checklists, NCR workflow, live multi-user sync via Socket.io.

### Run
```bash

npm install express socket.io express-rate-limit
API_KEY=your-secret node idd_production_server.js   # :3002
# open http://localhost:3002/
```

## Security notes
- All vendor API keys live server-side in `.env` — never sent to the browser
- Mutation routes require `X-API-Key`; Socket.io connections are authenticated
- All user-supplied text is HTML-escaped before rendering; CORS locked to allowlisted origins
- Known limitation: shared API key + self-asserted usernames — replace with per-user JWT before production use
