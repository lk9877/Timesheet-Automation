import * as fs from 'node:fs';
import { chromium } from '@playwright/test';
import { ENV } from '../lib/env';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { loadUsersWithAuth } from '../lib/userPool';

/**
 * Verify every user with captured auth can log in and add a task.
 * Uses the same task-picking flow as the scenario runner.
 */
async function main(): Promise<void> {
    const pool = loadUsersWithAuth();
    if (pool.length === 0) {
        console.log('No users with auth. Run: npm run capture-auth -- --label user1');
        process.exit(1);
    }

    const browser = await chromium.launch({ channel: ENV.browserChannel(), headless: ENV.headless() });
    let allOk = true;
    let okCount = 0;

    try {
        for (const user of pool) {
            process.stdout.write(`\n${user.label} (${user.email})… `);

            const context = await browser.newContext({
                storageState: user.authStatePath,
                viewport: { width: 1440, height: 900 },
            });
            const page = await context.newPage();
            const ui = new EmployeeInterfacePage(page);

            try {
                await ui.gotoAndWaitReady(ENV.interfaceUrl());
                const name = await ui.loggedInUser();
                if (!name) {
                    console.log('FAIL — not logged in (auth expired?)');
                    console.log(`  Re-capture: npm run capture-auth -- --label ${user.label}`);
                    allOk = false;
                    continue;
                }

                await ui.selectTimesheetUserIfNeeded(name);
                const weekNav = await ui.advanceToWeekWithAvailableTasks({ maxForward: 4, maxBackward: 4 });
                if (!weekNav.found || !weekNav.selection) {
                    console.log(`FAIL — no selectable task (logged in as "${name}")`);
                    allOk = false;
                    continue;
                }

                const picked =
                    weekNav.selection.kind === 'non-project'
                        ? weekNav.selection.label
                        : `${weekNav.selection.project} / ${weekNav.selection.task}`;

                const before = await ui.taskRowCount();
                await ui.clickAddTask();
                const after = await ui.waitForTaskAdded(before, 8_000);
                const unsaved = await ui.hasUnsavedChanges();
                if (after > before || unsaved) {
                    okCount++;
                    console.log(`OK — logged in as "${name}", picked "${picked}"`);
                } else {
                    const alerts = await ui.getAlertMessages();
                    const banner = alerts.find(m => /cannot add task|users table/i.test(m));
                    console.log('FAIL — add did not create a row');
                    if (banner) console.log(`  UI: ${banner}`);
                    allOk = false;
                }
            } catch (err) {
                console.log('FAIL');
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
                if (/auth|login|logged out/i.test(msg)) {
                    console.log(`  Re-capture: npm run capture-auth -- --label ${user.label}`);
                }
                allOk = false;
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }

    console.log('');
    console.log(`Ready: ${okCount}/${pool.length} user(s) can add tasks`);
    if (!allOk) process.exit(1);
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
