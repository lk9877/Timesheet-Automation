import { test, expect } from '@playwright/test';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { loadUserPool } from '../lib/userPool';
import { ENV } from '../lib/env';

const SMOKE_USER = loadUserPool()[0];

/**
 * Single-user smoke test. Uses the *first* user in users.json. Run this
 * before scaling up to the concurrent load test — if the smoke test fails,
 * the concurrent run will fail too and burn a lot more time.
 */
test.describe('employee timesheet — smoke', () => {
    test.use({ storageState: SMOKE_USER.authStatePath });

    test('loads the timesheet UI for a single user', async ({ page }) => {
        const ui = new EmployeeInterfacePage(page);
        const url = ENV.interfaceUrl();

        const { tReadyMs } = await ui.gotoAndWaitReady(url);
        expect(await ui.isLoggedOut()).toBe(false);
        expect(tReadyMs).toBeGreaterThan(0);
        expect(tReadyMs).toBeLessThan(60_000);

        // The timesheet UI lives inside an Airtable iframe in production —
        // hasTimesheetUi() scans all frames for us.
        expect(await ui.hasTimesheetUi()).toBe(true);
    });
});
