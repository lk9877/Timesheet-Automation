import * as fs from 'node:fs';
import { chromium } from '@playwright/test';
import { ENV } from '../lib/env';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { loadUserPool } from '../lib/userPool';

/**
 * Verify every user in users.json can log in and add a task.
 * Run before `npm run run:3x2` to catch Users-table setup issues early.
 */
async function main(): Promise<void> {
    const pool = loadUserPool();
    const browser = await chromium.launch({ channel: ENV.browserChannel(), headless: ENV.headless() });
    let allOk = true;

    try {
        for (const user of pool) {
            process.stdout.write(`\n${user.label} (${user.email})… `);
            if (!fs.existsSync(user.authStatePath)) {
                console.log('SKIP — auth not captured');
                console.log(`  Run: npm run capture-auth -- --label ${user.label}`);
                allOk = false;
                continue;
            }

            const context = await browser.newContext({
                storageState: user.authStatePath,
                viewport: { width: 1440, height: 900 },
            });
            const page = await context.newPage();
            const ui = new EmployeeInterfacePage(page);

            try {
                await ui.gotoAndWaitReady(ENV.interfaceUrl());
                const name = await ui.loggedInUser();
                const before = await ui.taskRowCount();
                const picked = await ui.pickFirstNonProjectTask();
                if (!picked) {
                    console.log('FAIL — no task to pick');
                    allOk = false;
                    continue;
                }
                await ui.clickAddTask();
                const after = await ui.waitForTaskAdded(before, 8_000);
                const unsaved = await ui.hasUnsavedChanges();
                if (after > before || unsaved) {
                    console.log(`OK — logged in as "${name ?? '?'}", can add tasks`);
                } else {
                    const alerts = await ui.getAlertMessages();
                    const banner = alerts.find(m => /cannot add task|users table/i.test(m));
                    console.log('FAIL');
                    if (banner) console.log(`  UI: ${banner}`);
                    console.log(
                        `  Fix: In Airtable → Users Table, add a row with email "${user.email}" (must match login exactly).`,
                    );
                    allOk = false;
                }
            } catch (err) {
                console.log('FAIL');
                console.log(`  ${err instanceof Error ? err.message : String(err)}`);
                allOk = false;
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }

    console.log('');
    if (!allOk) process.exit(1);
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
