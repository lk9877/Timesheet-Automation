import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatSummary, runMixedLoadTest, splitIntoWeeklyBatches, type VuAssignment } from '../lib/loadHarness';
import { ENV } from '../lib/env';
import { getUserByLabel, loadUserPool } from '../lib/userPool';

interface ScenarioGroup {
    users: number;
    recordsPerUser: number;
}

interface ScenarioRun {
    recordsPerUser: number;
}

interface ScenarioFile {
    groups?: ScenarioGroup[];
    runs?: ScenarioRun[];
    userLabels: string[];
}

function loadScenario(fileArg?: string): ScenarioFile {
    const scenarioPath = fileArg
        ? path.resolve(process.cwd(), fileArg)
        : path.resolve(ENV.repoRoot(), 'scenarios', 'mixed-records.json');
    if (!fs.existsSync(scenarioPath)) {
        throw new Error(`Scenario file not found: ${scenarioPath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioFile;
    if (!parsed.userLabels?.length) {
        throw new Error(`Scenario file ${scenarioPath} must contain "userLabels".`);
    }
    if (!parsed.runs?.length && !parsed.groups?.length) {
        throw new Error(`Scenario file ${scenarioPath} must contain "runs" or "groups".`);
    }
    return parsed;
}

/** Expand legacy groups → flat list of { label, records }. */
export function buildAssignments(scenario: ScenarioFile): { label: string; records: number }[] {
    if (scenario.runs?.length) {
        throw new Error(
            'Scenario uses "runs" (same users, separate record counts). ' +
                'Run each via npm run run:3x15 etc., not as one combined assignment.',
        );
    }
    const groups = scenario.groups!;
    const expectedUsers = groups.reduce((sum, g) => sum + g.users, 0);
    if (scenario.userLabels.length !== expectedUsers) {
        throw new Error(
            `Scenario needs ${expectedUsers} user labels but userLabels has ${scenario.userLabels.length}.`,
        );
    }

    const out: { label: string; records: number }[] = [];
    let labelIdx = 0;
    for (const group of groups) {
        for (let i = 0; i < group.users; i++) {
            out.push({ label: scenario.userLabels[labelIdx++], records: group.recordsPerUser });
        }
    }
    return out;
}

/** Dry-run validation — prints what's needed without launching browsers. */
export function validateScenario(scenario: ScenarioFile): { ok: boolean; messages: string[] } {
    const messages: string[] = [];
    let ok = true;

    try {
        if (scenario.runs?.length) {
            messages.push(`Users: ${scenario.userLabels.length} (${scenario.userLabels.join(', ')})`);
            messages.push('');
            messages.push('Separate runs (same 3 users each time):');
            for (const run of scenario.runs) {
                messages.push(`  npm run run:3x${run.recordsPerUser}`);
            }
            messages.push('');
            messages.push('Or all four in sequence: npm run scenario:all');
        } else {
            const flat = buildAssignments(scenario);
            const totalRecords = flat.reduce((sum, a) => sum + a.records, 0);
            messages.push(`Users: ${flat.length}, total task rows to add: ${totalRecords}`);
            messages.push('');
            messages.push('Per-user plan (9–10 tasks/week, Mon–Sun hours filled):');
            for (const a of flat) {
                const weeks = splitIntoWeeklyBatches(a.records);
                messages.push(`  ${a.label}: ${a.records} records → weeks [${weeks.join(', ')}]`);
            }
        }

        const pool = loadUserPool();
        const poolLabels = new Set(pool.map(u => u.label));
        const missingLabels = scenario.userLabels.filter(label => !poolLabels.has(label));
        if (missingLabels.length > 0) {
            ok = false;
            messages.push('');
            messages.push('Missing from users file:');
            for (const label of missingLabels) messages.push(`  ${label}`);
        }

        const missingAuth = pool.filter(
            u => scenario.userLabels.includes(u.label) && !fs.existsSync(u.authStatePath),
        );
        if (missingAuth.length > 0) {
            ok = false;
            messages.push('');
            messages.push('Auth not captured (run capture-auth):');
            for (const u of missingAuth) {
                messages.push(`  npm run capture-auth -- --label ${u.label}`);
            }
        }

        if (ok) {
            messages.push('');
            messages.push('Scenario is ready to run.');
        }
    } catch (err) {
        ok = false;
        messages.push(err instanceof Error ? err.message : String(err));
    }

    return { ok, messages };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const validateOnly = args.includes('--validate');
    const sequential = args.includes('--sequential');

    const fileArgIdx = args.indexOf('--scenario');
    const scenarioFile = fileArgIdx >= 0 ? args[fileArgIdx + 1] : undefined;

    const scenario = loadScenario(scenarioFile);
    const validation = validateScenario(scenario);
    for (const line of validation.messages) process.stdout.write(`${line}\n`);

    if (validateOnly) {
        if (!validation.ok) process.exit(1);
        return;
    }

    if (!validation.ok) {
        process.stderr.write('\nFix the issues above before running.\n');
        process.exit(1);
    }

    const flat = buildAssignments(scenario);
    const assignments: VuAssignment[] = flat.map(({ label, records }) => ({
        user: getUserByLabel(label),
        recordCount: records,
    }));

    const staggerArg = args.indexOf('--stagger-ms');
    const staggerMs = staggerArg >= 0 && args[staggerArg + 1] ? Number(args[staggerArg + 1]) : 750;

    const hoursArg = args.indexOf('--hours');
    const mutationHoursValue = hoursArg >= 0 && args[hoursArg + 1] ? args[hoursArg + 1] : '0.25';

    const summary = await runMixedLoadTest(assignments, {
        sequential,
        staggerMs,
        mutationHoursValue,
        mutationFillAllDays: true,
        mutationTasksPerWeekMin: 9,
        mutationTasksPerWeekMax: 10,
    });
    process.stdout.write(formatSummary(summary));

    if (summary.metrics.failureCount > 0) {
        process.exitCode = 1;
    }
}

void main().catch(err => {
    console.error(err);
    process.exit(1);
});
