import { chromium, type Browser } from '@playwright/test';
import { ENV } from './env';

/**
 * Launch a browser for Airtable load tests.
 *
 * Airtable blocks Playwright's bundled Chromium ("browser not supported") and
 * the timesheet iframe never loads. Use installed Google Chrome by default.
 */
export async function launchBrowser(overrides?: { headless?: boolean; channel?: string }): Promise<Browser> {
    const headless = overrides?.headless ?? ENV.headless();
    const channel = overrides?.channel ?? ENV.browserChannel();
    if (channel) {
        return chromium.launch({ headless, channel });
    }
    return chromium.launch({ headless });
}
