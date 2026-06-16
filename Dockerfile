# Single image for both services (run with different commands via compose).
# Debian slim (glibc) so better-sqlite3's prebuilt binary installs cleanly.
#
# node:22-bookworm-slim tracks the latest Node 22.x LTS patch, which keeps
# the node binary itself free of published CVEs. For production, pin to a
# specific digest after pulling:
#   docker pull node:22-bookworm-slim
#   docker inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}'
FROM node:22-bookworm-slim

# gosu lets the entrypoint fix volume ownership as root, then drop to an
# unprivileged user to actually run the app (containers do not run as root).
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies first (better build caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# State (SQLite DBs, users.json, session secret, revocations) lives on a mounted
# volume, not in the image. Both services point here via DATA_DIR.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001 3002

# Entrypoint chowns the mounted /data volume then runs the app as user `node`.
ENTRYPOINT ["docker-entrypoint.sh"]
# Default command; compose overrides per service.
CMD ["node", "acc_backend_server.js"]
