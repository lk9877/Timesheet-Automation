import { type Browser, type BrowserContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchBrowser } from './browser';
import { ENV } from './env';
import { EmployeeInterfacePage } from './employeeInterface';
import { assignUsers, type PoolUser } from './userPool';

export interface VirtualUserResult {
    vuIndex: number;
    label: string;
    email: string;
    success: boolean;
    error: string | null;
    tNavMs: number | null;
    tReadyMs: number | null;
    tFirstInteractionMs: number | null;
    tEndMs: number;
    weekClickCount: number;
    /** Per-action outcomes for the mutation scenario (pickTask, addTask, fillHours, save, removeRow, copyLastWeek). */
    actions: { name: string; ok: boolean; ms: number; detail?: string }[];
}

export interface LoadRunSummary {
    startedAt: string;
    finishedAt: string;
    interfaceUrl: string;
    concurrentUsers: number;
    soakMs: number;
    results: VirtualUserResult[];
    metrics: {
        successCount: number;
        failureCount: number;
        readyP50Ms: number | null;
        readyP95Ms: number | null;
        readyMaxMs: number | null;
        wallClockMs: number;
    };
}

function logProgress(message: string): void {
    process.stderr.write(`[load] ${message}\n`);
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

interface ScenarioOptions {
    /**
     * If true, virtual users will navigate weeks (Prev / Next) during the soak
     * to exercise the interface beyond just the initial load.
     */
    exerciseWeekNav?: boolean;
    /**
     * If true, run the full mutation scenario per VU: pick a task → add task →
     * fill hours → save → optionally remove row, with each action timed.
     */
    exerciseMutations?: boolean;
    /** Hours value to enter when exerciseMutations is true. Default '1'. */
    mutationHoursValue?: string;
    /** Day-of-week index 0=Mon … 6=Sun for the cell to fill. Default 0. */
    mutationDayIndex?: number;
    /** If true, attempt to remove the just-added row at the end of the scenario. */
    mutationTryRemove?: boolean;
    /** If true, attempt to "Copy last week tasks" early in the scenario. */
    mutationTryCopyLastWeek?: boolean;
    /** How many task rows to add + save per virtual user when exerciseMutations is true. Default 1. */
    mutationRecordCount?: number;
    /** Spacing between VU starts in ms (vuIndex * staggerMs). Default 0. */
    staggerMs?: number;
    /** Run virtual users one after another instead of in parallel. */
    sequential?: boolean;
    /** Navigation timeout (page.goto). Default 90 000 ms. */
    navigationTimeoutMs?: number;
    /** Default action timeout. Default 30 000 ms. */
    actionTimeoutMs?: number;
}

async function runVirtualUser(
    browser: Browser,
    user: PoolUser,
    vuIndex: number,
    interfaceUrl: string,
    soakMs: number,
    opts: ScenarioOptions,
): Promise<VirtualUserResult> {
    const startedAt = Date.now();
    const result: VirtualUserResult = {
        vuIndex,
        label: user.label,
        email: user.email,
        success: false,
        error: null,
        tNavMs: null,
        tReadyMs: null,
        tFirstInteractionMs: null,
        tEndMs: 0,
        weekClickCount: 0,
        actions: [],
    };

    const recordAction = async (name: string, fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<void> => {
        const start = Date.now();
        try {
            const r = await fn();
            result.actions.push({ name, ok: r.ok, ms: Date.now() - start, detail: r.detail });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            result.actions.push({ name, ok: false, ms: Date.now() - start, detail });
        }
    };

    let context: BrowserContext | null = null;
    try {
        logProgress(`[VU${vuIndex} ${user.label}] starting…`);

        // Stagger start times by 0–250 ms per VU to avoid a thundering-herd
        // burst on the local machine (which would otherwise spawn N Chromium
        // processes simultaneously and starve them all of CPU during page load).
        if (opts.staggerMs && opts.staggerMs > 0) {
            await new Promise(r => setTimeout(r, vuIndex * opts.staggerMs!));
        }

        context = await browser.newContext({
            storageState: user.authStatePath,
            viewport: { width: 1440, height: 900 },
        });
        context.setDefaultNavigationTimeout(opts.navigationTimeoutMs ?? 90_000);
        context.setDefaultTimeout(opts.actionTimeoutMs ?? 30_000);
        const page = await context.newPage();
        const ui = new EmployeeInterfacePage(page);

        logProgress(`[VU${vuIndex} ${user.label}] loading interface…`);
        const { tNavMs, tReadyMs } = await ui.gotoAndWaitReady(interfaceUrl);
        result.tNavMs = tNavMs;
        result.tReadyMs = tReadyMs;
        logProgress(`[VU${vuIndex} ${user.label}] ready in ${tReadyMs} ms`);

        if (await ui.isLoggedOut()) {
            throw new Error(
                `Auth state for ${user.label} was rejected by Airtable — recapture with "npm run capture-auth -- --label ${user.label}".`,
            );
        }

        const tFirst = Date.now();
        result.tFirstInteractionMs = tFirst - startedAt;

        if (opts.exerciseMutations) {
            const dayIndex = opts.mutationDayIndex ?? 0;
            const hoursValue = opts.mutationHoursValue ?? '1';
            const tryRemove = opts.mutationTryRemove === true;
            const tryCopyLastWeek = opts.mutationTryCopyLastWeek === true;

            await recordAction('verifySession', async () => {
                const name = await ui.loggedInUser();
                return {
                    ok: name != null,
                    detail: name ? `Logged in as: ${name} (expected pool user ${user.email})` : 'could not read logged-in user',
                };
            });

            await recordAction('preflightAddTask', async () => {
                const displayName = await ui.loggedInUser();
                const before = await ui.taskRowCount();
                const picked = await ui.pickFirstNonProjectTask();
                if (!picked) return { ok: false, detail: 'no task available to pick' };
                await ui.clickAddTask();
                const after = await ui.waitForTaskAdded(before, 8_000);
                const unsaved = await ui.hasUnsavedChanges();
                const ok = after > before || unsaved;
                if (!ok) {
                    const alerts = await ui.getAlertMessages();
                    const banner = alerts.find(m => /cannot add task|users table/i.test(m));
                    const who = displayName ?? user.email;
                    const detail = banner
                        ? `${who}: ${banner} — add a Users table row with email "${user.email}" (same as Airtable login).`
                        : `${who} cannot add tasks — add a Users table row with email "${user.email}" (compare with a working user like Laiba Kafayat).`;
                    return { ok: false, detail };
                }
                // Undo preflight row so the real scenario starts clean.
                if (after > before) {
                    await ui.clickRemoveOnRow(after - 1).catch(() => {});
                }
                return { ok: true, detail: `add-task works (picked: ${picked})` };
            });

            const preflight = result.actions.find(a => a.name === 'preflightAddTask');
            if (preflight && !preflight.ok) {
                throw new Error(preflight.detail ?? 'preflight add-task failed');
            }

            if (tryCopyLastWeek) {
                await recordAction('copyLastWeek', async () => {
                    const can = await ui.canCopyLastWeek();
                    if (!can) return { ok: false, detail: 'Copy last week button is disabled (no prior week / view-only)' };
                    const ok = await ui.copyLastWeekTasks();
                    return { ok, detail: ok ? 'clicked + confirmed' : 'click failed' };
                });
                await page.waitForTimeout(800);
            }

            const recordCount = Math.max(1, opts.mutationRecordCount ?? 1);
            for (let rec = 0; rec < recordCount; rec++) {
                const suffix = recordCount > 1 ? `#${rec + 1}` : '';
                const cellDay = (dayIndex + rec) % 7;

                await recordAction(`pickNonProjectTask${suffix}`, async () => {
                    const label = await ui.pickFirstNonProjectTask();
                    return label
                        ? { ok: true, detail: `picked: ${label}` }
                        : { ok: false, detail: 'no available non-project task to pick' };
                });

                let rowCountBefore = await ui.taskRowCount().catch(() => 0);

                await recordAction(`clickAddTask${suffix}`, async () => {
                    await ui.clickAddTask();
                    return { ok: true };
                });

                let rowCountAfter = await ui.waitForTaskAdded(rowCountBefore);

                if (rowCountAfter <= rowCountBefore && !(await ui.hasUnsavedChanges())) {
                    await recordAction(`pickProjectTask${suffix}`, async () => {
                        const project = await ui.pickProject();
                        const task = await ui.pickFirstProjectTask();
                        if (!project || !task) {
                            return { ok: false, detail: `project=${project ?? 'none'} task=${task ?? 'none'}` };
                        }
                        return { ok: true, detail: `project=${project} task=${task}` };
                    });
                    rowCountBefore = await ui.taskRowCount().catch(() => 0);
                    await recordAction(`clickAddTaskProject${suffix}`, async () => {
                        await ui.clickAddTask();
                        return { ok: true };
                    });
                    rowCountAfter = await ui.waitForTaskAdded(rowCountBefore);
                }

                const targetRow = Math.max(0, rowCountAfter - 1);

                await recordAction(`fillCellHours${suffix}`, async () => {
                    for (let attempt = 0; attempt < 8; attempt++) {
                        const ok = await ui.fillCellHours(targetRow, cellDay, hoursValue);
                        if (ok) {
                            return { ok: true, detail: `row=${targetRow} day=${cellDay} value=${hoursValue} (rows=${rowCountAfter})` };
                        }
                        await page.waitForTimeout(400);
                    }
                    const unsaved = await ui.hasUnsavedChanges();
                    return {
                        ok: false,
                        detail: `row=${targetRow} day=${cellDay} value=${hoursValue} (rows=${rowCountAfter}, unsaved=${unsaved})`,
                    };
                });

                await recordAction(`save${suffix}`, async () => {
                    if (!(await ui.hasUnsavedChanges())) return { ok: false, detail: 'nothing to save' };
                    const { tSaveMs } = await ui.save();
                    return { ok: true, detail: `${tSaveMs} ms` };
                });

                if (tryRemove) {
                    await recordAction(`clickRemoveOnRow${suffix}`, async () => {
                        const ok = await ui.clickRemoveOnRow(targetRow);
                        return {
                            ok,
                            detail: ok
                                ? `removed row=${targetRow}`
                                : `remove blocked (validation: cannot remove rows with saved hours)`,
                        };
                    });
                }
            }
        }

        // Soak: keep the page alive for the configured duration so you can
        // visually observe the UI before tear-down.
        const soakEnd = Date.now() + soakMs;
        let direction: 'next' | 'prev' = 'next';
        while (Date.now() < soakEnd) {
            if (opts.exerciseWeekNav) {
                try {
                    if (direction === 'next') await ui.clickNextWeek();
                    else await ui.clickPrevWeek();
                    direction = direction === 'next' ? 'prev' : 'next';
                    result.weekClickCount += 1;
                } catch {
                    /* button may be disabled at week boundaries */
                }
            }
            await page.waitForTimeout(2_000);
        }

        if (opts.exerciseMutations) {
            const saveActions = result.actions.filter(a => a.name.startsWith('save'));
            const savesOk = saveActions.length > 0 && saveActions.every(a => a.ok);
            result.success = savesOk;
            if (!savesOk && !result.error) {
                const failed = saveActions.filter(a => !a.ok).map(a => a.name).join(', ');
                result.error = failed ? `Save failed: ${failed}` : 'No save actions ran';
            }
        } else {
            result.success = true;
        }
    } catch (err) {
        result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        logProgress(`[VU${vuIndex} ${user.label}] failed: ${result.error}`);
    } finally {
        if (context) {
            try {
                await context.close();
            } catch {
                /* ignore teardown errors */
            }
        }
        result.tEndMs = Date.now() - startedAt;
        if (result.success) {
            logProgress(`[VU${vuIndex} ${user.label}] done in ${result.tEndMs} ms`);
        }
    }

    return result;
}

export async function runLoadTest(opts: ScenarioOptions = {}): Promise<LoadRunSummary> {
    const interfaceUrl = ENV.interfaceUrl();
    const concurrentUsers = ENV.concurrentUsers();
    const soakMs = ENV.soakMs();
    const allowReuse = ENV.allowReuse();

    const assignment = assignUsers(concurrentUsers, allowReuse);

    fs.mkdirSync(path.resolve(ENV.repoRoot(), 'test-results'), { recursive: true });

    const wallStart = Date.now();
    const startedAt = new Date().toISOString();

    logProgress(
        `Launching ${concurrentUsers} virtual user(s)${opts.sequential ? ' sequentially' : ' in parallel'} ` +
            `(browser=${ENV.browserChannel()}, headless=${ENV.headless()})…`,
    );

    const browser = await launchBrowser();

    let results: VirtualUserResult[];
    try {
        if (opts.sequential) {
            results = [];
            for (let i = 0; i < assignment.length; i++) {
                results.push(await runVirtualUser(browser, assignment[i], i, interfaceUrl, soakMs, opts));
            }
        } else {
            results = await Promise.all(
                assignment.map((user, i) => runVirtualUser(browser, user, i, interfaceUrl, soakMs, opts)),
            );
        }
    } finally {
        await browser.close();
    }

    const finishedAt = new Date().toISOString();
    const wallClockMs = Date.now() - wallStart;

    const successes = results.filter(r => r.success);
    const readyTimes = successes.map(r => r.tReadyMs ?? 0);
    const summary: LoadRunSummary = {
        startedAt,
        finishedAt,
        interfaceUrl,
        concurrentUsers,
        soakMs,
        results,
        metrics: {
            successCount: successes.length,
            failureCount: results.length - successes.length,
            readyP50Ms: percentile(readyTimes, 50),
            readyP95Ms: percentile(readyTimes, 95),
            readyMaxMs: readyTimes.length > 0 ? Math.max(...readyTimes) : null,
            wallClockMs,
        },
    };

    const out = path.resolve(ENV.repoRoot(), 'test-results', `load-run-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    return summary;
}

export function formatSummary(s: LoadRunSummary): string {
    const lines: string[] = [];
    lines.push('');
    lines.push('=== Concurrent load run summary ===');
    lines.push(`Interface:        ${s.interfaceUrl}`);
    lines.push(`Virtual users:    ${s.concurrentUsers}`);
    lines.push(`Soak per user:    ${s.soakMs} ms`);
    lines.push(`Wall clock:       ${s.metrics.wallClockMs} ms`);
    lines.push(`Successful VUs:   ${s.metrics.successCount}/${s.results.length}`);
    lines.push(`Failures:         ${s.metrics.failureCount}`);
    lines.push(`Time-to-ready p50: ${s.metrics.readyP50Ms ?? 'n/a'} ms`);
    lines.push(`Time-to-ready p95: ${s.metrics.readyP95Ms ?? 'n/a'} ms`);
    lines.push(`Time-to-ready max: ${s.metrics.readyMaxMs ?? 'n/a'} ms`);
    lines.push('');
    lines.push('Per-user results:');
    for (const r of s.results) {
        const session = r.actions.find(a => a.name === 'verifySession');
        const who = session?.detail?.replace(/^Logged in as:\s*/, '').split(' (expected')[0] ?? r.email;
        const saves = r.actions.filter(a => a.name.startsWith('save') && a.ok).length;
        const status = r.success ? `OK (${saves} saved)` : 'FAILED';
        lines.push(`  ${r.label} (${who}): ${status}`);
        if (!r.success && r.error) lines.push(`    → ${r.error.replace(/^Error:\s*/, '')}`);
    }
    if (s.metrics.failureCount > 0) {
        lines.push('');
        lines.push('Failures:');
        for (const r of s.results.filter(r => !r.success)) {
            lines.push(`  [VU${r.vuIndex} ${r.label}] ${r.error}`);
        }
    }
    const actionNames = Array.from(new Set(s.results.flatMap(r => r.actions.map(a => a.name))));
    if (actionNames.length > 0) {
        lines.push('');
        lines.push('Per-action results:');
        for (const name of actionNames) {
            const samples = s.results.flatMap(r => r.actions.filter(a => a.name === name));
            const ok = samples.filter(a => a.ok).length;
            const tot = samples.length;
            const okMs = samples.filter(a => a.ok).map(a => a.ms);
            const p50 = okMs.length ? percentile(okMs, 50) : null;
            const p95 = okMs.length ? percentile(okMs, 95) : null;
            lines.push(`  ${name.padEnd(22)} ${ok}/${tot} ok   p50 ${p50 ?? 'n/a'} ms   p95 ${p95 ?? 'n/a'} ms`);
        }
    }
    lines.push('');
    return lines.join('\n');
}
