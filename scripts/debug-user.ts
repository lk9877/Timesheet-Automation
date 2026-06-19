import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV } from '../lib/env';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { loadUserPool } from '../lib/userPool';

async function main(): Promise<void> {
    const label = process.argv[2] ?? 'user2';
    const user = loadUserPool().find(u => u.label === label);
    if (!user) throw new Error(`No user with label ${label}`);

    const browser = await chromium.launch({ headless: ENV.headless() });
    const context = await browser.newContext({ storageState: user.authStatePath, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const ui = new EmployeeInterfacePage(page);

    await ui.gotoAndWaitReady(ENV.interfaceUrl());
    console.log('logged in as:', await ui.loggedInUser());
    console.log('alerts:', await ui.getAlertMessages());
    console.log('rows:', await ui.taskRowCount());
    console.log('unsaved:', await ui.hasUnsavedChanges());

    const picked = await ui.pickFirstNonProjectTask();
    console.log('picked:', picked);
    await ui.clickAddTask();
    await page.waitForTimeout(2000);
    console.log('rows after add:', await ui.taskRowCount());
    console.log('unsaved after add:', await ui.hasUnsavedChanges());

    try {
        await ui.openLogTimeModal();
        const root = await ui.frame();
        const dialog = (root as import('@playwright/test').Page).locator('[role="dialog"]');
        console.log('modal buttons:', await dialog.locator('button').allTextContents());
        console.log('modal inputs:', await dialog.locator('input').count());
        console.log('modal labels:', await dialog.locator('label').allTextContents());
        await ui.closeLogTimeModal();
    } catch (err) {
        console.log('log time modal error:', err);
    }

    const out = path.resolve(ENV.repoRoot(), 'test-results', `debug-${label}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await ui.screenshot(out);
    console.log('screenshot:', out);

    await page.waitForTimeout(5000);
    await browser.close();
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
