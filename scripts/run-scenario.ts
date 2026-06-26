import { formatSummary, runMixedLoadTest } from '../lib/loadHarness';
import {
    buildScenarioAssignments,
    DEFAULT_TASKS_PER_WEEK_MAX,
    DEFAULT_TASKS_PER_WEEK_MIN,
    formatScenarioPlan,
    parseScenarioSpec,
} from '../lib/scenarioRun';

/**
 * Run a timesheet mutation scenario: <users>x<tasks>
 *
 *   npm run scenario -- 3x20
 *   npm run scenario -- 1x30
 *   npm run scenario -- allx30
 *   npm run scenario -- 3x20 --parallel
 *   npm run scenario -- allx15 --validate
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const validateOnly = args.includes('--validate');
    const positional = args.filter(a => !a.startsWith('--'));
    const spec = parseScenarioSpec(positional[0]);
    const assignments = buildScenarioAssignments(spec);

    const planLines = formatScenarioPlan(spec, assignments);
    for (const line of planLines) process.stdout.write(`${line}\n`);

    if (validateOnly) return;

    const parallel = args.includes('--parallel');
    const sequential = !parallel;

    const staggerArg = args.indexOf('--stagger-ms');
    const staggerMs =
        staggerArg >= 0 && args[staggerArg + 1] ? Number(args[staggerArg + 1]) : parallel ? 750 : 500;

    const hoursArg = args.indexOf('--hours');
    const mutationHoursValue = hoursArg >= 0 && args[hoursArg + 1] ? args[hoursArg + 1] : '0.25';

    process.stdout.write('\n');

    const summary = await runMixedLoadTest(assignments, {
        sequential,
        staggerMs,
        mutationHoursValue,
        mutationFillAllDays: true,
        mutationTasksPerWeekMin: DEFAULT_TASKS_PER_WEEK_MIN,
        mutationTasksPerWeekMax: DEFAULT_TASKS_PER_WEEK_MAX,
    });
    process.stdout.write(formatSummary(summary));

    if (summary.metrics.failureCount > 0) {
        process.exitCode = 1;
    }
}

void main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
