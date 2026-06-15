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
| Cloud VPS (DigitalOcean, Hetzner, AWS Lightsail, Azure VM) | Simplest. Public IP for DNS + Let's Encrypt. **Recommended for pilot.** |
| On-prem Linux VM | Works if ports 80/443 are reachable from the internet for ACME, or use Caddy's DNS-01 challenge (see Caddy docs). |
| Windows + WSL2 / Docker Desktop | Staging only — not for production exposure. |

Requirements: Linux with Docker Engine + Docker Compose v2, ports 80/443 open.

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

All durable state is on the `state` volume (`users.json`, `.revoked.json`,
`acc.db`, `idd.db`).

```bash
# Backup (timestamped tarball of the volume)
docker run --rm -v klim_state:/data -v "$PWD":/backup busybox \
    tar czf /backup/klim-state-$(date +%F).tgz -C /data .

# Restore
docker compose down
docker run --rm -v klim_state:/data -v "$PWD":/backup busybox \
    sh -c 'cd /data && tar xzf /backup/klim-state-YYYY-MM-DD.tgz'
docker compose up -d
```

Schedule the backup via cron. **Test a restore before relying on it.** The IDD
server also writes a JSON snapshot before each `/api/production/reset`.

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
