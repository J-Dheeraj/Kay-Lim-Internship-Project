# Single image for both services (run with different commands via compose).
# Debian slim (glibc) so better-sqlite3's prebuilt binary installs cleanly.
#
# Pinned to an immutable digest for reproducible, supply-chain-safe builds.
# To update: pull the new tag, get its amd64 digest, replace the sha256 below:
#   curl -s https://hub.docker.com/v2/repositories/library/node/tags/22-bookworm-slim \
#     | python3 -c "import sys,json,d=json.load(sys.stdin); \
#       print(next(i['digest'] for i in d['images'] if i['architecture']=='amd64'))"
FROM node:22-bookworm-slim@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644

# gosu lets the entrypoint fix volume ownership as root, then drop to an
# unprivileged user to actually run the app (containers do not run as root).
RUN apt-get update \
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

EXPOSE 3001

# Entrypoint chowns the mounted /data volume then runs the app as user `node`.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
