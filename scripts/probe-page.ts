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

    const outDir = path.resolve(ENV.repoRoot(), 'test-results');
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: user.authStatePath, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const ui = new EmployeeInterfacePage(page);

    await page.goto(ENV.interfaceUrl(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await ui.waitReady(120_000);

    console.log('user:', await ui.loggedInUser());
    console.log('rows before:', await ui.taskRowCount());
    console.log('inputs before:', await (await ui.frame()).locator('input.ts-weekly-hour-input').count());

    const picked = await ui.pickFirstNonProjectTask();
    console.log('picked:', picked);
    await ui.clickAddTask();
    await page.waitForTimeout(3000);

    const root = await ui.frame();
    console.log('rows after:', await ui.taskRowCount());
    console.log('inputs after:', await root.locator('input.ts-weekly-hour-input').count());
    console.log('unsaved:', await ui.hasUnsavedChanges());
    console.log('tbody text:', (await root.locator('table tbody').innerText().catch(() => '')).slice(0, 500));
    console.log('add disabled:', await root.getByRole('button', { name: /^Add task$/ }).first().getAttribute('aria-disabled'));

    try {
        await ui.openLogTimeModal();
        const modal = root.locator('[role="dialog"]');
        console.log('modal title:', await modal.locator('#log-time-modal-title').textContent().catch(() => ''));
        console.log('modal buttons:', await modal.locator('button').allTextContents());
        console.log('modal inputs:', await modal.locator('input').evaluateAll(els =>
            els.map(el => ({
                type: (el as HTMLInputElement).type,
                aria: el.getAttribute('aria-label'),
                ph: (el as HTMLInputElement).placeholder,
            })),
        ));
        await ui.closeLogTimeModal();
    } catch (err) {
        console.log('modal error:', err);
    }

    await page.screenshot({ path: path.join(outDir, `probe-${label}-after-add.png`), fullPage: true });
    await browser.close();
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
