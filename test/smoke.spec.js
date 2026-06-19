/**
 * Playwright smoke tests — browser-level validation that both apps
 * load and function correctly under the enforced CSP.
 *
 * What these tests prove (that npm test cannot):
 *  - The browser actually executes the external JS files (no CSP block)
 *  - Login works end-to-end (form → POST /api/login → token → reload)
 *  - Navigation via data-section delegates fires correctly
 *  - No Content Security Policy violation errors in the console
 *
 * Run with: npm run smoke
 * CI:       the "smoke" GitHub Actions job (ubuntu-latest, chromium)
 */
import { test, expect } from '@playwright/test';

const ACC = 'http://127.0.0.1:3001';
const IDD = 'http://127.0.0.1:3001/idd';
const PW  = process.env._SMOKE_PW;

// Collect CSP violation console errors during a page visit
function collectCspViolations(page) {
  const violations = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t.includes('Content Security Policy') || t.includes('content-security-policy'))
        violations.push(t);
    }
  });
  return violations;
}

// ── ACC Command Centre ──────────────────────────────────────────────────────

test.describe('ACC Command Centre', () => {
  test('external JS is served and has correct content-type', async ({ request }) => {
    const res = await request.get(`${ACC}/construction_dashboard.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
  });

  test('login and dashboard load with no CSP violations', async ({ page }) => {
    const cspViolations = collectCspViolations(page);

    await page.goto(`${ACC}/`);
    await expect(page.locator('#login-overlay')).toBeVisible();

    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', PW);
    await page.locator('button[type="submit"]').click();

    // After login the page reloads; overview tab should become active
    await expect(page.locator('#tab-overview')).toHaveClass(/active/, { timeout: 20_000 });

    // JS executed — the lastSync clock element should have been populated
    await expect(page.locator('#lastSync')).not.toHaveText('—');

    expect(cspViolations, 'No CSP violations on ACC dashboard').toHaveLength(0);
  });

  test('sidebar nav data-section delegates work', async ({ page }) => {
    await page.goto(`${ACC}/`);
    await expect(page.locator('#login-overlay')).toBeVisible();
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', PW);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#tab-overview')).toHaveClass(/active/, { timeout: 20_000 });

    // Click a nav item that uses data-section (not onclick)
    await page.locator('[data-section="acc-issues"]').click();
    await expect(page.locator('#tab-acc-issues')).toHaveClass(/active/);

    await page.locator('[data-section="idd-production"]').click();
    await expect(page.locator('#tab-idd-production')).toHaveClass(/active/);
  });
});

// ── IDD Digital Production ─────────────────────────────────────────────────

test.describe('IDD Digital Production', () => {
  test('external JS is served and has correct content-type', async ({ request }) => {
    const res = await request.get(`${ACC}/idd_production_app.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
  });

  test('login and dashboard load with no CSP violations', async ({ page }) => {
    const cspViolations = collectCspViolations(page);

    await page.goto(`${IDD}/`);
    await expect(page.locator('#login-overlay')).toBeVisible();

    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', PW);
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('#tab-dashboard')).toHaveClass(/active/, { timeout: 20_000 });

    // Dashboard KPI elements should exist (JS executed)
    await expect(page.locator('#kpi-total')).toBeVisible();

    expect(cspViolations, 'No CSP violations on IDD dashboard').toHaveLength(0);
  });

  test('nav data-section delegates: elements and NCR register', async ({ page }) => {
    await page.goto(`${IDD}/`);
    await expect(page.locator('#login-overlay')).toBeVisible();
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', PW);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#tab-dashboard')).toHaveClass(/active/, { timeout: 20_000 });

    // Element register
    await page.locator('[data-section="elements"]').click();
    await expect(page.locator('#tab-elements')).toHaveClass(/active/);

    // NCR register
    await page.locator('[data-section="ncrs"]').click();
    await expect(page.locator('#tab-ncrs')).toHaveClass(/active/);

    // QR scanner
    await page.locator('[data-section="scanner"]').click();
    await expect(page.locator('#tab-scanner')).toHaveClass(/active/);
  });

  test('Power BI embed shows graceful error when credentials not configured', async ({ page }) => {
    // ACC only — IDD doesn't have Power BI, so this is an ACC concern.
    // Verified via ACC smoke test (section navigation above reaches the tab).
    // This test ensures no JS exception when the pbi tab is clicked.
    await page.goto(`${ACC}/`);
    await expect(page.locator('#login-overlay')).toBeVisible();
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', PW);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#tab-overview')).toHaveClass(/active/, { timeout: 20_000 });

    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.locator('[data-section="powerbi"]').click();
    await expect(page.locator('#tab-powerbi')).toHaveClass(/active/);

    // Wait for the async loadAll() to settle; no uncaught JS exceptions expected
    await page.waitForTimeout(2000);
    expect(jsErrors.filter(e => !e.includes('net::ERR')), 'No uncaught JS errors on PBI tab').toHaveLength(0);
  });
});
