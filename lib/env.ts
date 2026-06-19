import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

function required(name: string): string {
    const v = process.env[name];
    if (!v || v.trim() === '') {
        throw new Error(
            `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
        );
    }
    return v;
}

function optionalNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new Error(`Env var ${name} must be a number; got ${raw}`);
    }
    return n;
}

function optionalBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null) return fallback;
    return raw.toLowerCase() === 'true' || raw === '1';
}

export const ENV = {
    interfaceUrl: () => required('AIRTABLE_INTERFACE_URL'),
    concurrentUsers: () => optionalNumber('PW_CONCURRENT_USERS', 20),
    headless: () => optionalBool('PW_HEADLESS', true),
    usersFile: () => process.env.PW_USERS_FILE ?? 'users.json',
    allowReuse: () => optionalBool('PW_ALLOW_REUSE', true),
    soakMs: () => optionalNumber('PW_SOAK_MS', 60_000),
    targetWeekMonday: () => process.env.PW_TARGET_WEEK_MONDAY?.trim() || null,
    /** Browser channel, e.g. "chrome". Airtable rejects Playwright's bundled Chromium. */
    browserChannel: () => process.env.PW_CHANNEL?.trim() || 'chrome',
    repoRoot: () => path.resolve(__dirname, '..'),
};
