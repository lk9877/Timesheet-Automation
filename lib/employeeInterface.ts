import { expect, type Locator, type Page, type Frame, type FrameLocator } from '@playwright/test';

/**
 * Page Object for the Airtable employee timesheet interface.
 *
 * Airtable renders custom interface extensions inside a sandbox iframe. We
 * resolve the right scope lazily so tests don't have to care whether they're
 * looking at the page or a frame.
 *
 * Selectors come from int_timesheet_employee/frontend/main/MainContent.tsx —
 * keep them in sync if the UI text or aria-labels change there.
 */
export class EmployeeInterfacePage {
    constructor(public readonly page: Page) {}

    /**
     * Navigate to the interface URL and wait for the timesheet UI to be visible.
     * Returns the time-to-ready in milliseconds, useful for load metrics.
     */
    async gotoAndWaitReady(url: string): Promise<{ tNavMs: number; tReadyMs: number }> {
        const t0 = Date.now();
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        const tNav = Date.now() - t0;

        await this.waitReady();
        const tReady = Date.now() - t0;
        return { tNavMs: tNav, tReadyMs: tReady };
    }

    /**
     * Resolve the scope that contains our React UI. Airtable wraps custom
     * interface extensions inside an iframe; we return the underlying Frame
     * (rather than a FrameLocator) so we can call evaluate() to drive
     * tricky popovers via DOM.
     */
    private async resolveRoot(): Promise<Page | Frame> {
        // Important: use an exact/regex match for "Timesheet". Airtable's outer
        // interface chrome contains a heading like "DEV Timesheet V3 (Laiba)
        // (Copy)" which would match a substring search and cause us to skip
        // the iframe entirely.
        if ((await this.page.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0) {
            return this.page;
        }
        for (const f of this.page.frames()) {
            try {
                if ((await f.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0 ||
                    (await f.getByText('Set up your table first', { exact: false }).count()) > 0) {
                    return f;
                }
            } catch {
                /* frame may have detached mid-scan */
            }
        }
        return this.page;
    }

    /** Public alias of resolveRoot for tests/scenarios that need scoped locators. */
    async frame(): Promise<Page | Frame> {
        return this.resolveRoot();
    }

    private async heading(): Promise<Locator> {
        const root = await this.resolveRoot();
        return (root as Page).getByRole('heading', { name: 'Timesheet' });
    }

    /**
     * Wait until the timesheet UI is visible somewhere on the page (main
     * frame or any iframe). Polls instead of using Promise.any so we don't
     * race against per-frame timeouts.
     */
    async waitReady(timeout = 90_000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if ((await this.page.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0) return;
            if ((await this.page.getByText('Set up your table first', { exact: false }).count()) > 0) return;
            for (const f of this.page.frames()) {
                try {
                    if ((await f.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0) return;
                    if ((await f.getByText('Set up your table first', { exact: false }).count()) > 0) return;
                } catch {
                    /* frame may have detached */
                }
            }
            await this.page.waitForTimeout(500).catch(() => {});
            if (this.page.isClosed()) throw new Error('Page was closed before timesheet UI appeared');
        }
        throw new Error('Timed out waiting for timesheet UI');
    }

    /**
     * Returns true when at least one frame on the page contains the timesheet UI.
     * Useful for tests that don't need to interact, only assert.
     */
    async hasTimesheetUi(): Promise<boolean> {
        if ((await this.page.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0) return true;
        if ((await this.page.getByText('Set up your table first', { exact: false }).count()) > 0) return true;
        for (const f of this.page.frames()) {
            try {
                if ((await f.locator('h1', { hasText: /^Timesheet$/ }).count()) > 0) return true;
                if ((await f.getByText('Set up your table first', { exact: false }).count()) > 0) return true;
            } catch {
                /* frame may have detached */
            }
        }
        return false;
    }

    /** True when the user is logged out / Airtable bounced us to the sign-in page. */
    async isLoggedOut(): Promise<boolean> {
        const url = this.page.url();
        if (/\/(login|signup|auth)\b/.test(url)) return true;
        const emailField = this.page.getByPlaceholder('Email address').first();
        return (await emailField.count()) > 0;
    }

    async openWeekPicker(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByPlaceholder('Select week (Monday)').click();
    }

    async clickPrevWeek(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByRole('button', { name: 'Prev week' }).click();
    }

    async clickNextWeek(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByRole('button', { name: 'Next week' }).click();
    }

    async clickCopyLastWeek(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByRole('button', { name: 'Copy last week tasks' }).click();
    }

    /**
     * Returns true when there are unsaved changes (the Save button is enabled
     * and shows a count). We use this to decide whether to call save() in the
     * load harness.
     */
    async hasUnsavedChanges(): Promise<boolean> {
        const root = await this.resolveRoot();
        const btn = (root as Page).getByRole('button', { name: /^Save(\s*\(\d+\))?$/ });
        if ((await btn.count()) === 0) return false;
        const disabled = await btn.first().getAttribute('aria-disabled');
        return disabled !== 'true';
    }

    async save(): Promise<{ tSaveMs: number }> {
        const root = await this.resolveRoot();
        const btn = (root as Page).getByRole('button', { name: /^Save(\s*\(\d+\))?$/ });
        await btn.first().click();
        const t0 = Date.now();
        // Wait for the spinning save overlay to disappear and the button label
        // to drop the "(N)" badge — the React component clears unsaved keys
        // once the batch resolves.
        await (root as Page)
            .locator('[role="status"][aria-label*="Saving"]')
            .first()
            .waitFor({ state: 'detached', timeout: 30_000 })
            .catch(() => {
                /* overlay may never have rendered for instant saves */
            });
        await expect(btn.first()).toHaveText(/^Save$/, { timeout: 30_000 }).catch(() => {});
        return { tSaveMs: Date.now() - t0 };
    }

    /** Open the "Log time" modal (button shown in the header). */
    async openLogTimeModal(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByRole('button', { name: 'Log time' }).first().click();
        await (root as Page).locator('[role="dialog"][aria-labelledby="log-time-modal-title"]').waitFor();
    }

    async closeLogTimeModal(): Promise<void> {
        const root = await this.resolveRoot();
        await (root as Page).getByRole('button', { name: 'Close' }).first().click();
    }

    async screenshot(filePath: string): Promise<void> {
        await this.page.screenshot({ path: filePath, fullPage: true });
    }

    // ---------------------------------------------------------------------
    // Mutation helpers (add task, fill hours, remove, copy last week)
    // ---------------------------------------------------------------------

    /**
     * Open the Non-project task dropdown and pick the first selectable option
     * (or one whose label includes `match`, case-insensitive). Returns the
     * label that was picked, or null if nothing was available.
     */
    async pickFirstNonProjectTask(match?: string): Promise<string | null> {
        return this.pickFromDropdown('Select non-project based task', match);
    }

    /**
     * Generic helper: open a SearchDropdown by its trigger aria-label and
     * pick the first option (optionally filtered by a substring).
     *
     * The dropdown's popover is portal'd into the iframe body via createPortal
     * with class containing `z-[9999]`. We use a tiny DOM script to find the
     * popover and click the first non-disabled option button — this is much
     * more robust than locator hunting because Playwright doesn't have a
     * stable ARIA relationship between the trigger and the option list.
     */
    private async pickFromDropdown(triggerAriaLabel: string, match?: string): Promise<string | null> {
        const debug = process.env.PW_DEBUG_MUTATIONS === '1';
        const log = (msg: string): void => {
            if (debug) console.log(`[pickFromDropdown:${triggerAriaLabel}] ${msg}`);
        };

        const root = await this.resolveRoot();
        log('root resolved');

        const trigger = root.getByRole('button', { name: triggerAriaLabel }).first();
        const triggerCount = await trigger.count();
        log(`trigger count = ${triggerCount}`);
        if (triggerCount === 0) return null;

        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await trigger.click();
        log('trigger clicked');

        const searchInput = root.locator('input[aria-label="Search options"]').first();
        try {
            await searchInput.waitFor({ state: 'visible', timeout: 5_000 });
            log('search input visible');
        } catch {
            log('search input NOT visible (popover did not open)');
            return null;
        }

        if (match) {
            await searchInput.fill(match);
            await this.page.waitForTimeout(150);
            log(`search filled: ${match}`);
        }

        const result = await root.evaluate((matchTxt: string | null) => {
            const search = document.querySelector('input[aria-label="Search options"]') as HTMLInputElement | null;
            if (!search) return { picked: null as string | null, reason: 'no search input in DOM' };
            let popover: Element | null = search.parentElement;
            while (popover && !(popover.className && typeof popover.className === 'string' && popover.className.includes('z-[9999]'))) {
                popover = popover.parentElement;
            }
            if (!popover) return { picked: null, reason: 'no popover ancestor with z-[9999]' };
            const buttons = Array.from(popover.querySelectorAll('button:not([disabled])')) as HTMLButtonElement[];
            if (buttons.length === 0) return { picked: null, reason: 'popover has zero non-disabled buttons' };
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (!text || text.length > 200) continue;
                if (matchTxt && !text.toLowerCase().includes(matchTxt.toLowerCase())) continue;
                btn.click();
                return { picked: text, reason: 'clicked' };
            }
            return { picked: null, reason: `no button matched (${buttons.length} candidates)` };
        }, match ?? null);

        log(`evaluate result: ${JSON.stringify(result)}`);

        if (!result.picked) {
            await this.page.keyboard.press('Escape').catch(() => {});
        }
        return result.picked;
    }

    /** Same as pickFirstNonProjectTask but for the project-based task dropdown. */
    async pickFirstProjectTask(match?: string): Promise<string | null> {
        return this.pickFromDropdown('Select project task', match);
    }

    /** Pick a project from the Project dropdown. */
    async pickProject(match?: string): Promise<string | null> {
        return this.pickFromDropdown('Select project', match);
    }

    /** Click the "Add task" button. Throws if it's disabled. */
    async clickAddTask(): Promise<void> {
        const root = (await this.resolveRoot()) as Page;
        const btn = root.getByRole('button', { name: /^Add task$/ }).first();
        await expect(btn).toBeEnabled({ timeout: 10_000 });
        await btn.click();
    }

    /** Number of weekly task rows currently in the grid. */
    async weeklyRowCount(): Promise<number> {
        const root = (await this.resolveRoot()) as Page;
        const rows = root.locator('table tbody tr').filter({ hasNot: root.locator('text=No tasks selected for this week') });
        return rows.count();
    }

    /** Row count from hour inputs when table rows are not detectable. */
    async taskRowCount(): Promise<number> {
        const root = (await this.resolveRoot()) as Page;
        const byTable = await this.weeklyRowCount();
        const inputs = await root.locator('input.ts-weekly-hour-input').count();
        const byInputs = inputs > 0 ? Math.ceil(inputs / 7) : 0;
        return Math.max(byTable, byInputs);
    }

    /** Poll until a new task row appears or the Save badge indicates pending changes. */
    async waitForTaskAdded(previousRowCount: number, timeout = 20_000): Promise<number> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const rows = await this.taskRowCount();
            if (rows > previousRowCount) return rows;
            if (await this.hasUnsavedChanges()) return Math.max(rows, previousRowCount + 1);
            await this.page.waitForTimeout(300);
        }
        return this.taskRowCount();
    }

    /** Poll until the grid has at least `minCount` task rows. */
    async waitForWeeklyRowCount(minCount: number, timeout = 15_000): Promise<number> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const count = await this.taskRowCount();
            if (count >= minCount) return count;
            await this.page.waitForTimeout(300);
        }
        return this.taskRowCount();
    }

    /**
     * Type hours into a specific weekly cell (rowIndex 0-based among task
     * rows, dayIndex 0-based 0=Monday … 6=Sunday). Best-effort: returns false
     * if the cell isn't found or is disabled.
     */
    async fillCellHours(rowIndex: number, dayIndex: number, value: string): Promise<boolean> {
        const root = (await this.resolveRoot()) as Page;
        const inputs = root.locator('input.ts-weekly-hour-input');
        const total = await inputs.count();
        if (total > 0) {
            const flatIndex = rowIndex * 7 + dayIndex;
            if (flatIndex < total) {
                const input = inputs.nth(flatIndex);
                const disabled = await input.getAttribute('disabled');
                if (disabled === null) {
                    await input.click();
                    await input.fill(value);
                    await input.blur();
                    return true;
                }
            }
        }
        const rowInputs = root.locator(`table tbody tr:nth-child(${rowIndex + 1}) input.ts-weekly-hour-input`);
        if ((await rowInputs.count()) <= dayIndex) return false;
        const input = rowInputs.nth(dayIndex);
        const disabled = await input.getAttribute('disabled');
        if (disabled !== null) return false;
        await input.click();
        await input.fill(value);
        await input.blur();
        return true;
    }

    /** Click "Remove" on a specific row. Returns false if the button is disabled. */
    async clickRemoveOnRow(rowIndex: number): Promise<boolean> {
        const root = (await this.resolveRoot()) as Page;
        const removeBtn = root.locator(`table tbody tr:nth-child(${rowIndex + 1}) button:has-text("Remove")`).first();
        if ((await removeBtn.count()) === 0) return false;
        const aria = await removeBtn.getAttribute('aria-disabled');
        const disabled = await removeBtn.getAttribute('disabled');
        if (aria === 'true' || disabled !== null) return false;
        await removeBtn.click();
        return true;
    }

    /** True if the "Copy last week tasks" button is currently enabled. */
    async canCopyLastWeek(): Promise<boolean> {
        const root = (await this.resolveRoot()) as Page;
        const btn = root.getByRole('button', { name: 'Copy last week tasks' }).first();
        if ((await btn.count()) === 0) return false;
        const aria = await btn.getAttribute('aria-disabled');
        const disabled = await btn.getAttribute('disabled');
        return aria !== 'true' && disabled === null;
    }

    /**
     * Click "Copy last week tasks" if enabled, confirm the modal, then wait
     * for the modal to close. Returns true on success, false if the toolbar
     * button is disabled or the modal never closes (e.g. confirm Save was
     * disabled due to no copyable tasks).
     */
    async copyLastWeekTasks(): Promise<boolean> {
        if (!(await this.canCopyLastWeek())) return false;
        const root = (await this.resolveRoot()) as Page;
        await root.getByRole('button', { name: 'Copy last week tasks' }).first().click();

        const modal = root.locator('[role="dialog"][aria-labelledby="copy-last-week-modal-title"]').first();
        try {
            await modal.waitFor({ state: 'visible', timeout: 10_000 });
        } catch {
            return false;
        }

        // The confirm button inside the modal is labeled "Save" (not "Copy").
        const confirmBtn = modal.locator('button.ts-btn-primary', { hasText: /^Save$/ }).first();
        try {
            await confirmBtn.waitFor({ state: 'visible', timeout: 5_000 });
            const aria = await confirmBtn.getAttribute('aria-disabled');
            const disabled = await confirmBtn.getAttribute('disabled');
            if (aria === 'true' || disabled !== null) {
                // No tasks to copy — close via Cancel so we don't block later clicks.
                await modal.locator('button', { hasText: /^Cancel$/ }).first().click().catch(() => {});
                return false;
            }
            await confirmBtn.click();
        } catch {
            await modal.locator('button', { hasText: /^Cancel$/ }).first().click().catch(() => {});
            return false;
        }

        // Wait for the modal to disappear so subsequent clicks aren't intercepted.
        await modal.waitFor({ state: 'detached', timeout: 30_000 }).catch(async () => {
            // Fallback: force close via Escape if the modal stayed up.
            await this.page.keyboard.press('Escape').catch(() => {});
        });
        return true;
    }

    /** Returns the displayed user name from the header, or null if not found. */
    async loggedInUser(): Promise<string | null> {
        const root = (await this.resolveRoot()) as Page;
        const strong = root.locator('p:has-text("Logged in as:") strong').first();
        if ((await strong.count()) === 0) return null;
        return (await strong.innerText().catch(() => '')).trim() || null;
    }

    /** Pink/red alert banners shown above the timesheet grid (errors, warnings). */
    async getAlertMessages(): Promise<string[]> {
        const root = (await this.resolveRoot()) as Page;
        const alerts = root.locator('[role="alert"]');
        const count = await alerts.count();
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
            const text = (await alerts.nth(i).innerText().catch(() => '')).trim();
            if (text) out.push(text.replace(/\s+/g, ' '));
        }
        return out;
    }
}
