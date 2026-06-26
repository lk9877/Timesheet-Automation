import { countUsersWithAuth, loadUsersWithAuth } from '../lib/userPool';
import { ENV } from '../lib/env';

/** Print how many pool users have captured auth (ready to automate). */
async function main(): Promise<void> {
    const pool = loadUsersWithAuth();
    const total = countUsersWithAuth();

    process.stdout.write(`Users file: ${ENV.usersFile()}\n`);
    process.stdout.write(`Users with auth ready: ${total}\n`);

    if (total === 0) {
        process.stdout.write('\nNo auth captured yet. Example:\n');
        process.stdout.write('  npm run capture-auth -- --label user1\n');
        process.exit(1);
        return;
    }

    process.stdout.write('\n');
    for (const u of pool) {
        process.stdout.write(`  ${u.label}  ${u.email}\n`);
    }

    process.stdout.write('\nRun examples:\n');
    process.stdout.write(`  npm run scenario -- ${total}x20\n`);
    process.stdout.write('  npm run scenario -- allx30\n');
}

void main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
