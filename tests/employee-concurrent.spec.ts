import { test, expect } from '@playwright/test';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { assignUsers } from '../lib/userPool';
import { ENV } from '../lib/env';

/**
 * One Playwright "test" per virtual user. Playwright's worker pool spins up
 * `workers: PW_CONCURRENT_USERS` (set in playwright.config.ts) so they run in
 * parallel. This is the assertion-friendly counterpart to scripts/run-load.ts —
 * use this when you want a green/red CI gate; use run-load.ts when you want
 * raw timing metrics.
 */
const CONCURRENCY = ENV.concurrentUsers();
const ALLOW_REUSE = ENV.allowReuse();
const URL = ENV.interfaceUrl();
const SOAK_MS = Math.min(ENV.soakMs(), 30_000);

const ASSIGNMENT = assignUsers(CONCURRENCY, ALLOW_REUSE);

test.describe.configure({ mode: 'parallel' });

for (let i = 0; i < CONCURRENCY; i++) {
    const user = ASSIGNMENT[i];

    test.describe(`VU${i + 1} (${user.label})`, () => {
        test.use({ storageState: user.authStatePath });

        test(`loads the timesheet under load (VU ${i + 1}/${CONCURRENCY})`, async ({ page }) => {
            const ui = new EmployeeInterfacePage(page);

            const { tReadyMs } = await ui.gotoAndWaitReady(URL);
            expect(await ui.isLoggedOut(), `VU${i + 1} got bounced to login`).toBe(false);
            expect(tReadyMs, `VU${i + 1} time-to-ready`).toBeLessThan(60_000);

            await page.waitForTimeout(SOAK_MS);

            expect(await ui.hasTimesheetUi()).toBe(true);
        });
    });
}
