#!/bin/sh
# Run as root only to fix ownership of the mounted state volume, then drop to
# the unprivileged `node` user to run the application.
set -e
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
exec gosu node "$@"
