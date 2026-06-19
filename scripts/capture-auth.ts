import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchBrowser } from '../lib/browser';
import { ENV } from '../lib/env';

/**
 * Open a Playwright Chromium window pointed at the Airtable interface, wait
 * for you to sign in, then save the cookies + localStorage to
 * auth/<label>.json so subsequent test runs are fully logged in.
 *
 * No keypress required — the script polls until the timesheet UI is visible
 * (i.e. you're past the login page) and then auto-saves and closes.
 *
 * On a successful capture the entry is also (idempotently) appended to
 * users.json so it gets picked up by the next load run automatically.
 *
 * Usage:
 *   npm run capture-auth -- --label employee01
 *   npm run capture-auth -- --label employee01 --email you+e01@gmail.com
 *   npm run capture-auth -- --label employee01 --url https://airtable.com/...
 *   npm run capture-auth -- --label employee01 --timeout-ms 300000
 */
function parseArgs(): { label: string; email: string | null; url: string | null; loginTimeoutMs: number } {
    const args = process.argv.slice(2);
    let label: string | null = null;
    let email: string | null = null;
    let url: string | null = null;
    let loginTimeoutMs = 5 * 60_000;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--label' && args[i + 1]) {
            label = args[++i];
        } else if (args[i] === '--email' && args[i + 1]) {
            email = args[++i];
        } else if (args[i] === '--url' && args[i + 1]) {
            url = args[++i];
        } else if (args[i] === '--timeout-ms' && args[i + 1]) {
            loginTimeoutMs = Number(args[++i]);
        }
    }
    if (!label) {
        console.error('Missing --label. Example: npm run capture-auth -- --label employee01');
        process.exit(1);
    }
    return { label, email, url, loginTimeoutMs };
}

/**
 * Append (or update) an entry in users.json so the new auth state is wired up
 * automatically. Idempotent: re-capturing for an existing label refreshes its
 * email but keeps a single entry per label.
 */
function upsertUsersEntry(usersFile: string, label: string, email: string, authStateRel: string): void {
    let parsed: { users: { label: string; email: string; authState: string }[] } = { users: [] };
    if (fs.existsSync(usersFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            if (raw && Array.isArray(raw.users)) parsed = raw;
        } catch {
            console.warn(`Existing ${usersFile} was not valid JSON — overwriting.`);
        }
    }
    const idx = parsed.users.findIndex(u => u.label === label);
    const entry = { label, email, authState: authStateRel };
    if (idx >= 0) parsed.users[idx] = entry; else parsed.users.push(entry);
    fs.writeFileSync(usersFile, JSON.stringify(parsed, null, 4) + '\n', 'utf8');
}

async function main(): Promise<void> {
    const { label, email, url, loginTimeoutMs } = parseArgs();
    const target = url ?? ENV.interfaceUrl();

    const root = ENV.repoRoot();
    const outDir = path.resolve(root, 'auth');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.resolve(outDir, `${label}.json`);
    const authStateRel = path.posix.join('auth', `${label}.json`);
    const usersFile = path.resolve(root, ENV.usersFile());

    console.log(`\nOpening Chromium for label "${label}" at:\n  ${target}\n`);
    console.log('Sign in to Airtable in the window that pops up.');
    console.log('The script will auto-detect once the timesheet UI is visible and save your cookies.');
    console.log(`(Up to ${Math.round(loginTimeoutMs / 1000)} seconds to sign in.)\n`);

    const browser = await launchBrowser({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    let exitCode = 0;
    try {
        const deadline = Date.now() + loginTimeoutMs;
        let lastReportedUrl = '';
        let stableSince = 0;
        while (Date.now() < deadline) {
            const url = page.url();
            const onLogin = /\/(login|signup|auth)\b/.test(url);
            if (url !== lastReportedUrl) {
                console.log(`  current URL: ${url}${onLogin ? ' (still on login)' : ''}`);
                lastReportedUrl = url;
                stableSince = onLogin ? 0 : Date.now();
            } else if (!onLogin && stableSince > 0 && Date.now() - stableSince > 4_000) {
                break;
            }
            await page.waitForTimeout(1_500).catch(() => {});
            if (page.isClosed()) break;
        }

        const finalUrl = page.url();
        if (/\/(login|signup|auth)\b/.test(finalUrl)) {
            console.error(`Still on the login page after ${Math.round(loginTimeoutMs / 1000)}s — sign-in did not complete.`);
            exitCode = 1;
        } else {
            console.log(`Off the login page (${finalUrl}). Saving cookies…`);
            await context.storageState({ path: outPath });
            console.log(`Saved ${outPath}`);
            upsertUsersEntry(usersFile, label, email ?? `${label}@captured.local`, authStateRel);
            console.log(`Updated ${usersFile} (label=${label}).`);
        }
    } catch (err) {
        console.error(`capture-auth failed: ${err instanceof Error ? err.message : err}`);
        exitCode = 1;
    } finally {
        await browser.close().catch(() => {});
    }

    if (exitCode === 0) {
        console.log('\nDone. The next load run will pick up this user automatically.');
    }
    process.exit(exitCode);
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
