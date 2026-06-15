# Deployment & Operations Runbook

Containerised deployment of the two services behind a Caddy reverse proxy that
auto-provisions HTTPS for your domain. Suitable for a controlled pilot.

```
                 ┌──────────────────────── host (Linux + Docker) ────────────────────────┐
 supervisor DNS  │  Caddy :80/:443  ── auto Let's Encrypt TLS, HSTS, HTTP→HTTPS, wss      │
 A/AAAA records ─┼─▶ ${DOMAIN}, cc.${DOMAIN}  ─▶ acc  :3001  (Command Centre + /api)       │
                 │   idd.${DOMAIN}            ─▶ idd  :3002  (IDD Production app + /api)    │
                 │  shared `state` volume: users.json, .revoked.json, acc.db, idd.db       │
                 └─────────────────────────────────────────────────────────────────────────┘
```

Both services share identity via the same `SESSION_SECRET` and the same
`users.json`/`.revoked.json` on the `state` volume, so a login or a logout is
valid on either service.

## 1. Host options (you said host is not decided)

Any of these works — the artifacts are host-agnostic:

| Host | Notes |
|------|-------|
| Cloud VPS (DigitalOcean, Hetzner, AWS Lightsail, GCP Compute Engine) | Simplest. Stable public IP for DNS + Let's Encrypt. **Recommended.** A small instance (2 vCPU / 2–4 GB) comfortably serves 10+ sites. |
| On-prem Linux VM | Works if ports 80/443 are reachable from the internet for ACME, or use Caddy's DNS-01 challenge (see Caddy docs). |
| Windows + WSL2 / Docker Desktop | Staging only — not for production exposure. |

> **Note on "cloud":** you need a *compute host* (a server/VM), not cloud
> **storage**. Google **Drive / Dropbox / OneDrive cannot run this** — they only
> store files. The Google equivalent of a server is **Google Cloud → Compute
> Engine**, not Drive. Any small Linux VM works.

**One central deployment serves all sites and HQ** — every site and the HQ office
access the same server over the internet via the domain (this is how Autodesk ACC
/ Procore work). Each user is scoped to their site; HQ sees all (see the
multi-site section in `README.md`). You do **not** deploy a separate copy per
site.

Requirements: Linux with Docker Engine + Docker Compose v2, ports 80/443 open.

### 1a. Deploying on Google Cloud (Compute Engine) — step by step

You can use Google, but it's **Google Cloud → Compute Engine** (a virtual
server), **not** Google Drive. Drive only stores files; its storage quota is
irrelevant here — the VM comes with its own disk (20 GB is ample for this app).

1. Go to **console.cloud.google.com** (not drive.google.com). Create a project
   and make sure billing is enabled.
2. **Compute Engine → VM instances → Create instance:**
   - Region: **asia-southeast1 (Singapore)** — closest to the sites.
   - Machine type: **e2-small** (2 vCPU, 2 GB) — enough for 10+ sites.
   - Boot disk: **Ubuntu 22.04 LTS**, 20 GB.
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
   - Create, then **reserve the External IP as static** (VPC network → IP
     addresses) so it doesn't change.
3. Click **SSH** on the instance to open a terminal, then install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER     # then close the SSH window and reconnect
   ```
4. Deploy:
   ```bash
   git clone https://github.com/J-Dheeraj/Kay-Lim-Internship-Project.git
   cd Kay-Lim-Internship-Project
   cp .env.deploy.example .env
   nano .env                          # set DOMAIN, SESSION_SECRET, ADMIN_PASSWORD
   docker compose --env-file .env up -d --build
   ```
5. Point the domain's A-records (step 2 below) at the VM's static External IP.
   HTTPS provisions automatically within a minute.

Cost: an e2-small in Singapore is roughly US$13–15/month (a smaller e2-micro
also works for a light pilot). This single VM serves all 10+ sites and HQ.

## 2. DNS (supervisor)

Point three records at the host's public IP:

```
${DOMAIN}        A   <host-ip>
cc.${DOMAIN}     A   <host-ip>
idd.${DOMAIN}    A   <host-ip>
```

Let's Encrypt issues certificates automatically once these resolve to the host.

## 3. Configure & launch

```bash
git clone https://github.com/J-Dheeraj/Kay-Lim-Internship-Project.git
cd Kay-Lim-Internship-Project
cp .env.deploy.example .env
#  set DOMAIN, generate SESSION_SECRET (openssl rand -hex 32), set ADMIN_PASSWORD,
#  add vendor credentials if available
docker compose --env-file .env up -d --build
```

First start prints the `head_of_it` (IT admin) bootstrap once if `ADMIN_PASSWORD`
is unset; here it uses the password you set. Verify:

```bash
curl -fsS https://${DOMAIN}/api/health        # {"status":"ok",...}
curl -fsS https://idd.${DOMAIN}/api/health
```

## 4. Users & roles

User management is a CLI inside either container (they share the store):

```bash
docker compose exec acc node auth.js add-user <name> <password> \
    [viewer|hr|inspector|pm|pd|gm|management|head_of_it]
docker compose exec acc node auth.js list-users
docker compose exec acc node auth.js remove-user <name>
```

See the README for the role/permission matrix.

## 5. Backup & restore

All durable state is on the **`klim_state`** volume (`users.json`,
`.revoked.json`, `acc.db`, `idd.db`). The Compose project is named `klim`
(`name: klim`), so the volume is always `klim_state`.

SQLite is in WAL mode, so a plain copy of `*.db` while a service is writing can
be inconsistent. For a **consistent** backup, briefly stop the writers (a few
seconds), snapshot, then start again — Caddy keeps serving:

```bash
# Consistent backup (timestamped tarball of the volume)
docker compose stop acc idd
docker run --rm -v klim_state:/data -v "$PWD":/backup busybox \
    tar czf /backup/klim-state-$(date +%F).tgz -C /data .
docker compose start acc idd

# Restore (overwrites current state)
docker compose down
docker run --rm -v klim_state:/data -v "$PWD":/backup busybox \
    sh -c 'cd /data && rm -f *.db *.db-wal *.db-shm && tar xzf /backup/klim-state-YYYY-MM-DD.tgz'
docker compose up -d
```

(Zero-downtime alternative: `sqlite3 acc.db ".backup /backup/acc.db"` and same
for `idd.db` — SQLite's online-backup API needs no stop.)

Schedule the backup via cron. **Test a restore before relying on it** — an
untested backup is not a backup. The IDD server also writes a JSON snapshot
before each `/api/production/reset`.

## 6. Monitoring & logs

- Health: `GET /api/health` on each service — wire to an uptime monitor.
- Audit integrity: `GET /api/production/audit/verify` (head_of_it) — alert if
  `valid:false`.
- Logs: `docker compose logs -f acc` / `idd` / `caddy`. For central aggregation,
  point a log driver at your platform (Loki, CloudWatch, etc.).

## 7. Update / rollback

```bash
# Update
git pull && docker compose up -d --build

# Rollback to a known-good commit
git checkout <previous-good-sha> && docker compose up -d --build
```

State persists across rebuilds (it's on the volume). CI (GitHub Actions) runs
the test suite on every push — only deploy commits that are green.

## 8. Known limits (be explicit with stakeholders)

- **Single host.** SQLite + local identity files mean this does not horizontally
  scale. For multi-instance/HA, move identity to an IdP, state to managed
  Postgres, and sessions/revocations to shared storage (see README/reviews).
- **TLS via Caddy/Let's Encrypt** requires the domain to resolve to the host and
  ACME reachability (HTTP-01 on :80, or configure DNS-01).
- **Vendor integrations** (ACC/Power BI/QSE/UniCon) must be verified against real
  tenant credentials separately.
