# Timesheet Playwright tests

Concurrent-user load and smoke tests for the **Airtable Timesheet employee
interface** (`int_timesheet_employee/`). Built with [Playwright](https://playwright.dev)
because Airtable interfaces don't work with most off-the-shelf load-testing
tools — they're rendered inside a sandboxed browser environment, so we need a
real browser to drive them.

The goal of this folder is to answer: **can the employee interface handle
~18–20 people using it at the same time without breaking?**

> Status (proof of concept): the harness is end-to-end runnable and produces
> real numbers, but it deliberately keeps scenarios shallow — page load, week
> navigation, optional Save — so we can demo the approach to Pav before
> investing in deeper scenarios (logging time, copy-last-week, etc.).

## What's in here

```
playwright_tests/
├── playwright.config.ts        Playwright config (workers = concurrent users)
├── package.json                Scripts + dependencies
├── .env.example                Copy to .env and fill in
├── users.example.json          Copy to users.json and add your test accounts
├── auth/                       Saved storageState JSONs go here (gitignored)
├── lib/
│   ├── env.ts                  Loads .env safely
│   ├── userPool.ts             Maps virtual users → real Airtable accounts
│   ├── employeeInterface.ts    Page Object: selectors for the timesheet UI
│   └── loadHarness.ts          Concurrent runner that produces metrics
├── scripts/
│   ├── capture-auth.ts         Interactive: log in once, save cookies
│   └── run-load.ts             Run N concurrent virtual users
└── tests/
    ├── employee-smoke.spec.ts       Single-user sanity check
    └── employee-concurrent.spec.ts  Same scenario × N users in parallel
```

## One-time setup

```powershell
cd playwright_tests
npm install
npm run install:browsers      # downloads Chromium
copy .env.example .env        # then edit .env
copy users.example.json users.json
```

Open `.env` and set:

- `AIRTABLE_INTERFACE_URL` — the full interface URL
  (`https://airtable.com/<baseId>/<interfaceId>`).
- `PW_CONCURRENT_USERS` — defaults to 20.
- `PW_SOAK_MS` — how long each virtual user keeps the page open after
  load (default 60 s).

## Capturing auth (one time per Airtable account)

Airtable login uses email + password and often Google SSO / MFA, so we don't
automate it. Instead, log in once per account and let Playwright save the
cookies + localStorage:

```powershell
npm run capture-auth -- --label employee01
```

That opens a Chromium window. Sign in normally, wait for the timesheet to
appear, then come back to the terminal and press `Enter`. The script writes
`auth/employee01.json`. Repeat for every real account you want in the pool,
then list them in `users.json`:

```json
{
    "users": [
        { "label": "employee01", "email": "alice@acme.com", "authState": "auth/employee01.json" },
        { "label": "employee02", "email": "bob@acme.com",   "authState": "auth/employee02.json" }
    ]
}
```

### How many real accounts do I need?

- **Best**: one Airtable account per simulated user. That gives you a true
  multi-user picture (record-ownership filtering, save conflicts, the
  per-user `WeeklySelection` table, etc.).
- **Acceptable for an interface stress test**: just 1–2 accounts. Set
  `PW_ALLOW_REUSE=true` and the harness will round-robin the same auth
  state across N browser contexts. This still loads the Airtable
  interface 20× concurrently from Airtable's perspective, which is what
  Pav was asking about. It will *not* surface bugs that need genuine
  multi-user state.

## Running the smoke test (start here)

```powershell
npm run test:smoke
```

This runs **one** virtual user end-to-end. Use it to verify your `.env`,
auth state, and selectors before scaling up.

## Running 20 concurrent users

Two ways, depending on what you want:

### A. Raw timing metrics (recommended for the "is it fast enough" question)

```powershell
npm run load
# or, also exercise week navigation during the soak:
npm run load -- --nav
```

The runner spawns `PW_CONCURRENT_USERS` browser contexts in parallel,
each one loads the interface, waits for the timesheet to render,
optionally clicks `Prev week` / `Next week`, and stays on the page for
`PW_SOAK_MS` before tearing down. At the end it prints something like:

```
=== Concurrent load run summary ===
Interface:        https://airtable.com/appXXX/pagYYY
Virtual users:    20
Soak per user:    60000 ms
Wall clock:       72431 ms
Successful VUs:   20/20
Failures:         0
Time-to-ready p50: 4128 ms
Time-to-ready p95: 7012 ms
Time-to-ready max: 7244 ms
```

A full per-VU breakdown is also written to
`test-results/load-run-<timestamp>.json`.

### B. CI-style green/red assertions

```powershell
npm run test:concurrent
```

Same scenario, but each virtual user becomes a Playwright `test()` so
they show up individually in the HTML report (`npm run report`). The
config sets `workers: PW_CONCURRENT_USERS`, so they all run at the same
time.

## Tuning concurrency

`workers: 20` in `playwright.config.ts` translates to 20 Chromium
processes. On a developer laptop that's roughly 4–6 GB of RAM and a
solid amount of CPU. If you see workers timing out before the page is
even rendered, the bottleneck is your machine, not Airtable — try:

- Closing other apps and running the test on a quiet machine.
- Lowering `PW_CONCURRENT_USERS` to e.g. 10 and noting that p95 already
  represents the worst case for the actual people clicking Save.
- Running the load test from a beefier machine or a cloud VM.

## What this currently exercises

For each virtual user:

1. Navigate to the interface URL with a logged-in cookie jar.
2. Wait for either the `Timesheet` heading or the "Set up your table"
   onboarding card.
3. (Optional, with `--nav`) Click `Prev week` / `Next week` every couple
   of seconds.
4. Stay on the page for the soak duration.
5. Tear down cleanly and report timings.

What it deliberately does **not** do yet (because we agreed to demo
this to Pav before sinking more time into it):

- Logging time via the modal.
- Filling weekly grid cells and clicking Save.
- `Copy last week tasks`.
- Asserting on cross-user state (e.g. user A doesn't see user B's rows).

The `EmployeeInterfacePage` page object already has helpers for the
modal and the Save button (`openLogTimeModal`, `save`,
`hasUnsavedChanges`, `clickCopyLastWeek`) so adding those scenarios
later is mostly a matter of writing the orchestration, not re-finding
selectors.

## Recording a demo video

PowerShell on Windows:

```powershell
# Show the actual browser windows pop up for the demo
$env:PW_HEADLESS="false"
$env:PW_CONCURRENT_USERS="3"     # so all windows fit on screen
npm run load -- --nav
```

Use any screen recorder (Xbox Game Bar `Win+G`, OBS, Loom). The 3-window
recording is the most legible illustration of "this is what 20 of them
running at once looks like".

## Why Playwright (not k6 / JMeter / Locust)

- **Airtable is a JS-heavy SPA hosted inside a sandboxed iframe.** The
  records you see in the timesheet aren't loaded over a stable REST
  contract you can replay — they're streamed via Airtable's own
  protocol and rendered by a custom React block. Tools that record HTTP
  traffic (k6, JMeter) can't replay this because the protocol changes
  per session and a lot of the work is client-side rendering anyway.
- **Playwright drives a real browser**, so what we measure is exactly
  what the user sees — initial paint, time until the timesheet is
  interactive, save round-trips. That's what the team actually cares
  about.
- **Storage state means we don't need to script Airtable's login**,
  which would otherwise be the hardest part (Google SSO, MFA, etc.).

## Troubleshooting

- **"Auth state for X was rejected by Airtable"** — Airtable's session
  cookies have a TTL. Re-run `npm run capture-auth -- --label X`.
- **Smoke test times out waiting for the heading** — open the browser
  manually, confirm the interface is named "Timesheet" (case sensitive)
  and shares the same heading text. If your interface uses different
  copy, update `EmployeeInterfacePage.waitReady()` in
  `lib/employeeInterface.ts`.
- **Selectors don't match anything** — Airtable wraps custom interface
  extensions in an iframe in some hosting modes. The page object already
  falls back through `frameLocator`, but if Airtable adds another layer
  you may need to extend `resolveRoot()`.
