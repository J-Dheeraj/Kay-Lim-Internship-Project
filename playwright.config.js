import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared temp dir for both servers — pre-populated by globalSetup
const DATA = mkdtempSync(join(tmpdir(), 'klim-smoke-'));
const SECRET = 'playwright-smoke-test-secret-aabb1122';
const PW     = 'smoke-admin-pw-1234';

// Expose to globalSetup (which runs in the same process before webServer starts)
process.env._SMOKE_DATA   = DATA;
process.env._SMOKE_PW     = PW;
process.env._SMOKE_SECRET = SECRET;

export default defineConfig({
  globalSetup: './test/smoke.setup.js',
  testDir:     './test',
  testMatch:   '**/*.spec.js',
  timeout:     30_000,
  use:         { headless: true },
  webServer: [
    {
      command:              'node acc_backend_server.js',
      url:                  'http://127.0.0.1:3001/api/health',
      reuseExistingServer:  false,
      timeout:              30_000,
      env: { PORT: '3001', DATA_DIR: DATA, SESSION_SECRET: SECRET, ADMIN_PASSWORD: PW },
    },
    {
      command:              'node idd_production_server.js',
      url:                  'http://127.0.0.1:3002/api/health',
      reuseExistingServer:  false,
      timeout:              30_000,
      env: { PORT: '3002', DATA_DIR: DATA, SESSION_SECRET: SECRET, ADMIN_PASSWORD: PW },
    },
  ],
});
