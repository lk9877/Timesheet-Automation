import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV } from './env';

export interface PoolUser {
    label: string;
    email: string;
    /** Absolute path to the saved Playwright storageState JSON. */
    authStatePath: string;
}

interface UsersFileShape {
    users: { label: string; email: string; authState: string }[];
}

/** Load and validate the users.json file. */
export function loadUserPool(): PoolUser[] {
    const root = ENV.repoRoot();
    const filePath = path.resolve(root, ENV.usersFile());
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Users file not found at ${filePath}. Copy users.example.json to ${ENV.usersFile()} and fill it in.`,
        );
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as UsersFileShape;
    if (!parsed?.users || !Array.isArray(parsed.users) || parsed.users.length === 0) {
        throw new Error(`Users file ${filePath} must contain a non-empty "users" array.`);
    }
    return parsed.users.map(u => {
        if (!u.label || !u.email || !u.authState) {
            throw new Error(`Each user entry needs label/email/authState. Bad entry: ${JSON.stringify(u)}`);
        }
        const authStatePath = path.resolve(root, u.authState);
        return { label: u.label, email: u.email, authStatePath };
    });
}

function authStateExists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** Users from the pool whose auth JSON file exists on disk. */
export function loadUsersWithAuth(): PoolUser[] {
    return loadUserPool().filter(u => authStateExists(u.authStatePath));
}

/** Count of users ready to run (auth captured). */
export function countUsersWithAuth(): number {
    return loadUsersWithAuth().length;
}

/**
 * Build the assignment of (virtual user index) -> (PoolUser) for a load run.
 *
 * - If the pool already has >= count entries, each VU gets its own dedicated account.
 * - Otherwise, when reuse is allowed, accounts are recycled round-robin so we can still
 *   stress the interface with N parallel browser contexts. This is the realistic Friday
 *   afternoon behaviour the team described, but won't produce N distinct Airtable
 *   *sessions* — see README for the trade-off.
 */
/** Look up a pool user by label (throws if missing). */
export function getUserByLabel(label: string): PoolUser {
    const pool = loadUserPool();
    const user = pool.find(u => u.label === label);
    if (!user) {
        const labels = pool.map(u => u.label).join(', ');
        throw new Error(`Unknown user label "${label}". Available: ${labels}`);
    }
    if (!authStateExists(user.authStatePath)) {
        throw new Error(
            `Auth state missing for ${label}. Run "npm run capture-auth -- --label ${label}".`,
        );
    }
    return user;
}

export function assignUsers(count: number, allowReuse: boolean): PoolUser[] {
    const pool = loadUserPool();
    const missing = pool.filter(u => !authStateExists(u.authStatePath));
    if (missing.length > 0) {
        const labels = missing.map(m => m.label).join(', ');
        throw new Error(
            `Auth states missing for: ${labels}. Run "npm run capture-auth -- --label <label>" for each.`,
        );
    }

    if (pool.length >= count) {
        return pool.slice(0, count);
    }
    if (!allowReuse) {
        throw new Error(
            `Need ${count} distinct accounts but users.json only has ${pool.length}. ` +
                `Add more accounts or set PW_ALLOW_REUSE=true to recycle them.`,
        );
    }
    const out: PoolUser[] = [];
    for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
    return out;
}
