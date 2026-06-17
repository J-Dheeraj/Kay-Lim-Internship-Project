/**
 * Playwright globalSetup — runs before webServer starts.
 * Pre-creates the shared users.json so both servers find the same
 * admin account on first boot (avoids a race between ACC and IDD
 * both trying to bootstrap the admin user simultaneously).
 */
import { hashPassword } from '../auth.js';
import fs from 'node:fs';
import path from 'node:path';

export default async function globalSetup() {
  const data = process.env._SMOKE_DATA;
  const pw   = process.env._SMOKE_PW;
  if (!data || !pw) throw new Error('Smoke env vars _SMOKE_DATA / _SMOKE_PW not set');

  fs.mkdirSync(data, { recursive: true });
  const users = { admin: { passwordHash: hashPassword(pw), role: 'head_of_it' } };
  fs.writeFileSync(
    path.join(data, 'users.json'),
    JSON.stringify(users, null, 2),
    { mode: 0o600 },
  );
}
