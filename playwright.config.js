import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared temp dir — pre-populated by globalSetup (smoke.setup.js).
// In CI, _SMOKE_DATA/_SMOKE_PW/_SMOKE_SECRET are injected by the
// "Generate ephemeral CI credentials" step in ci.yml and never committed.
// Locally, we fall back to ephemeral values so `playwright test` works without
// any env vars set.
const DATA   = process.env._SMOKE_DATA   ?? mkdtempSync(join(tmpdir(), 'klim-smoke-'));
const PW     = process.env._SMOKE_PW     ?? 'local-smoke-fallback-pw-12';
const SECRET = process.env._SMOKE_SECRET ?? 'local-smoke-fallback-secret-aabbccddeeff00112233445566778899';

process.env._SMOKE_DATA   = DATA;
process.env._SMOKE_PW     = PW;
process.env._SMOKE_SECRET = SECRET;

export default defineConfig({
  globalSetup: './test/smoke.setup.js',
  testDir:     './test',
  testMatch:   '**/*.spec.js',
  timeout:     60_000,
  use:         { headless: true, actionTimeout: 20_000 },
  webServer: {
    command:             'node server.js',
    url:                 'http://127.0.0.1:3001/api/health',
    reuseExistingServer: !process.env.CI,
    timeout:             60_000,
    env: {
      PORT:           '3001',
      DATA_DIR:       DATA,
      SESSION_SECRET: SECRET,
      ADMIN_PASSWORD: PW,
    },
  },
});
