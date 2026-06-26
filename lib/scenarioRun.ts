import { splitIntoWeeklyBatches, type VuAssignment } from './loadHarness';
import { loadUsersWithAuth, type PoolUser } from './userPool';

/** Default weekly task split for all scenario runs (Mon–Sun filled each week). */
export const DEFAULT_TASKS_PER_WEEK_MIN = 9;
export const DEFAULT_TASKS_PER_WEEK_MAX = 10;

export interface ScenarioSpec {
    /** Number of users, or `'all'` for every account with captured auth. */
    userCount: number | 'all';
    recordsPerUser: number;
    raw: string;
}

const SCENARIO_RE = /^(\d+|all)\s*x\s*(\d+)$/i;

export function parseScenarioSpec(input: string | undefined): ScenarioSpec {
    if (!input?.trim()) {
        throw new Error(
            'Missing scenario. Usage: npm run scenario -- <users>x<tasks>\n' +
                '  Examples: 1x30   3x20   4x15   allx30',
        );
    }
    const raw = input.trim().toLowerCase();
    const m = raw.match(SCENARIO_RE);
    if (!m) {
        throw new Error(
            `Invalid scenario "${input}". Use <users>x<tasks>, e.g. 3x20 or allx30.`,
        );
    }
    const userToken = m[1]!;
    const recordsPerUser = Number(m[2]!);
    if (!Number.isFinite(recordsPerUser) || recordsPerUser < 1) {
        throw new Error(`Task count must be a positive integer; got "${m[2]}".`);
    }
    const userCount = userToken === 'all' ? 'all' : Number(userToken);
    if (userCount !== 'all' && (!Number.isFinite(userCount) || userCount < 1)) {
        throw new Error(`User count must be a positive integer or "all"; got "${userToken}".`);
    }
    return { userCount, recordsPerUser, raw };
}

export function selectUsersForScenario(spec: ScenarioSpec): PoolUser[] {
    const pool = loadUsersWithAuth();
    if (pool.length === 0) {
        throw new Error(
            'No users with captured auth. Run: npm run capture-auth -- --label <label>',
        );
    }
    if (spec.userCount === 'all') return pool;
    if (pool.length < spec.userCount) {
        throw new Error(
            `Scenario ${spec.raw} needs ${spec.userCount} user(s) with auth but only ${pool.length} found. ` +
                `Capture more with npm run capture-auth -- --label <label>`,
        );
    }
    return pool.slice(0, spec.userCount);
}

export function buildScenarioAssignments(spec: ScenarioSpec): VuAssignment[] {
    return selectUsersForScenario(spec).map(user => ({
        user,
        recordCount: spec.recordsPerUser,
    }));
}

export function formatScenarioPlan(
    spec: ScenarioSpec,
    assignments: VuAssignment[],
    minPerWeek = DEFAULT_TASKS_PER_WEEK_MIN,
    maxPerWeek = DEFAULT_TASKS_PER_WEEK_MAX,
): string[] {
    const lines: string[] = [];
    lines.push(`Scenario: ${spec.raw} (${assignments.length} user(s), ${spec.recordsPerUser} tasks each)`);
    lines.push(`Weekly split: ${minPerWeek}–${maxPerWeek} tasks/week, Mon–Sun hours on every row`);
    lines.push('');
    for (const { user, recordCount } of assignments) {
        const weeks = splitIntoWeeklyBatches(recordCount, minPerWeek, maxPerWeek);
        lines.push(`  ${user.label} (${user.email}): ${recordCount} tasks → weeks [${weeks.join(', ')}]`);
    }
    return lines;
}
