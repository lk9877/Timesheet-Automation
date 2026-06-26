import * as fs from 'node:fs';
import { launchBrowser } from '../lib/browser';
import { ENV } from '../lib/env';
import { EmployeeInterfacePage } from '../lib/employeeInterface';
import { loadUserPool } from '../lib/userPool';

/** Quick diagnostic: can we open task dropdowns and pick an option? */
async function main(): Promise<void> {
    process.env.PW_DEBUG_MUTATIONS = '1';
    const user = loadUserPool()[0];
    if (!fs.existsSync(user.authStatePath)) {
        console.error(`No auth at ${user.authStatePath}. Run capture-auth first.`);
        process.exit(1);
    }

    const browser = await launchBrowser({ headless: false });
    const context = await browser.newContext({
        storageState: user.authStatePath,
        viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const ui = new EmployeeInterfacePage(page);

    try {
        console.log('URL:', ENV.interfaceUrl());
        await ui.gotoAndWaitReady(ENV.interfaceUrl());
        console.log('Logged in as:', await ui.loggedInUser());

        const selected = await ui.selectTimesheetUserIfNeeded(user.label);
        console.log('User dropdown selected:', selected);

        await ui.waitForTaskPickersReady();
        const nonProject = await ui.pickFirstNonProjectTask();
        console.log('Non-project pick:', nonProject);

        if (!nonProject) {
            const combined = await ui.pickCombinedProjectTask();
            console.log('Combined project pick:', combined);
        }
    } finally {
        await browser.close();
    }
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
