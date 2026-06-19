import { formatSummary, runLoadTest } from '../lib/loadHarness';

/**
 * Standalone concurrent load runner.
 *
 *   npm run load               # uses .env (PW_CONCURRENT_USERS, PW_SOAK_MS, ...)
 *   npm run load -- --nav      # also click Prev/Next week each cycle
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const exerciseWeekNav = args.includes('--nav');
    const exerciseMutations = args.includes('--mutate');
    const mutationTryRemove = args.includes('--remove');
    const mutationTryCopyLastWeek = args.includes('--copy-last-week');
    const sequential = args.includes('--sequential');

    const staggerArg = args.indexOf('--stagger-ms');
    const staggerMs = staggerArg >= 0 && args[staggerArg + 1] ? Number(args[staggerArg + 1]) : 500;

    const navArg = args.indexOf('--nav-timeout-ms');
    const navigationTimeoutMs = navArg >= 0 && args[navArg + 1] ? Number(args[navArg + 1]) : 90_000;

    const hoursArg = args.indexOf('--hours');
    const mutationHoursValue = hoursArg >= 0 && args[hoursArg + 1] ? args[hoursArg + 1] : '1';

    const dayArg = args.indexOf('--day');
    const mutationDayIndex = dayArg >= 0 && args[dayArg + 1] ? Number(args[dayArg + 1]) : 0;

    const recordsArg = args.indexOf('--records');
    const mutationRecordCount = recordsArg >= 0 && args[recordsArg + 1] ? Number(args[recordsArg + 1]) : 1;

    const summary = await runLoadTest({
        exerciseWeekNav,
        exerciseMutations,
        mutationHoursValue,
        mutationDayIndex,
        mutationTryRemove,
        mutationTryCopyLastWeek,
        mutationRecordCount,
        sequential,
        staggerMs,
        navigationTimeoutMs,
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
