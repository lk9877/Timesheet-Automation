import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(__dirname, '.env') });

const CONCURRENCY = Number(process.env.PW_CONCURRENT_USERS ?? 20);

export default defineConfig({
    testDir: './tests',
    timeout: 120_000,
    expect: { timeout: 15_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    // One worker per simulated user. Playwright caps the upper bound to a
    // sensible value relative to CPU/memory — see README for tuning notes.
    workers: CONCURRENCY,
    reporter: [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
    ],
    use: {
        baseURL: process.env.AIRTABLE_INTERFACE_URL,
        headless: process.env.PW_HEADLESS !== 'false',
        viewport: { width: 1440, height: 900 },
        actionTimeout: 20_000,
        navigationTimeout: 60_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    outputDir: 'test-results',
});
