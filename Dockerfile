# Single image for both services (run with different commands via compose).
# Debian slim (glibc) so better-sqlite3's prebuilt binary installs cleanly.
FROM node:22-bookworm-slim

WORKDIR /app

# Install production dependencies first (better build caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# State (SQLite DBs, users.json, session secret, revocations) lives on a mounted
# volume, not in the image. Both services point here via DATA_DIR.
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3001 3002

# Default command; compose overrides per service.
CMD ["node", "acc_backend_server.js"]
