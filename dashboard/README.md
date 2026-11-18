# Lab dashboard

A Preact single-page app on toonish-ui v0.5.0. Mobile first, WCAG 2.2 AA.

Each tab answers one question in its first 390 px screen, with a kit `verdict()`. The evidence sits under it in
numbered sections, and a `readout()` says what the tab read. `QUESTIONS` in `src/views.ts` holds the questions.

| Tab | Question | Leads with | Under a row that opens |
|---|---|---|---|
| Now | Do I need to do anything? | "Nothing needs you" in green, or what needs you in order | Nothing. Now has no counts and no charts |
| Act | What do I fix, in what order? | Each item with its step and a button | Recovered alerts and the triage record |
| Services | Can I fail over, and should I? | One switch card per service | Drill history, uptime and watchdog readings |
| Health | What is drifting toward trouble? | Backups and patches as two signals, then the last good backup per guest and the patch backlog | The alert and CVE trend charts |
| Work | What is waiting on me, and what is stuck? | The Plane items that wait on Pedro | The cycle and the other open items |

The dashboard is Pedro's phone remote for the lab. A tab leads with what he can act on, and insight sits lower.

## Commands

| Command | Does |
|---|---|
| `bun install` | Installs Preact, the kit and the test tools |
| `bun run build` | Writes `dist/` and fails when an output is missing |
| `bun run dev` | Builds, then serves `dist/` on `http://localhost:8090` |
| `bun test` | Tests the model and the feed |
| `bun run typecheck` | Runs `tsc --noEmit` |
| `bun run test:a11y` | Runs axe on 5 tabs, 4 feed states and 2 widths, and prints what it read |
| `bun run test/shots.ts <dir> <prefix>` | Writes a screenshot of each tab, fresh and stale, at phone and desktop width |

## How it works

- **One feed.** `src/data.ts` exposes `Feed`. The page reads `<meta name="dashboard-feed">`, set at build time with
  `DASHBOARD_FEED`, and defaults to `/fixtures/dashboard.json`. Moving the feed to another host changes that value, not a view.
- **Unknown is not healthy.** `src/model.ts` turns a missing, malformed or older-than-5-minutes record into `unknown`. A
  section that does not parse is dropped and listed in a banner.
- **Every view says what it read,** with counts and the age of the read.
- **Act ranks everything with a step.** `actItems()` in `src/views.ts` lists, in order: a service down on the side that
  serves, the action cards, a down alert with no card, exploited CVEs, a late backup, then critical and high CVEs with a
  fix. Each item has a step and a button. The button opens the `lab-action` workflow page or the Services tab. A recovery
  is not an item.
- **Now is the top of Act and the top of Work.** `attention()` folds the CVEs into one line per class and adds the Plane
  items that wait on Pedro. A source that was not read is listed last as `unknown`, so Now says all clear only when every
  source the feed carries was read.
- **Backups are an optional feed section.** `backups` holds `checkedAt` and one `{ guest, lastGood, detail }` per guest. A
  guest is late after 36 hours, and missing after 72 hours or with no good run. A feed with no `backups` section shows
  Backups as unknown on Health and does not hold Now at unknown. The fixture carries the section. The live feed in
  `src/reports/feed.ts` does not carry it yet.
- **Not in the feed yet:** drift, certificate expiry, pending `lab-write` taps and pull requests that wait for Pedro's
  word. Health and Work say so in their readout.
- **A switch card only asks.** Each service is a kit `switchCard()`: two buttons, with the serving side pressed. A tap on
  the other side opens a confirm step. `DASHBOARD_SWITCH` names a URL that queues a request. Without it, the idle side
  is disabled and says why. A switch is allowed only when the target side is fresh and healthy, and a service with a
  database needs a known replication lag.
- **The fixture has its own clock.** A feed whose `source` is `fixture` is read one minute after its `generatedAt`
  (`clockFor()` in `src/model.ts`), and a banner says the data is a demonstration. A live feed is read at the real time.
- **A poll keeps your place.** The page reads the feed every 30 seconds. An open row stays open and focus stays put.
- **Tabs belong to the kit.** `toonish-ui/toonish.js` switches the panels by hash. Preact leaves `hidden` alone.

## Data

The fixture holds synthetic values and example hostnames. Staging serves it and reads nothing from the lab.

## The AWS API (`api/`)

One Lambda (`nodejs22.x`, arm64, handler `handler.handler`) and one DynamoDB table `dash`. The header of
`api/handler.ts` lists the routes and keys. `bun run build:api` writes `api/dist/handler.mjs`, with the AWS SDK left
to the runtime. The function never stamps a check time, refuses a watchdog record dated in the future, and records a
switch request without moving anything. Tests use an in-memory table.

## Services and watchdog state

`src/failover/registry.ts` lists the services and which can move. The server reads each lab side's health URL on request (cached 20 seconds). A service with no URL, or a URL that redirects to a login, shows its lab side as unknown. Every cloud side reads unknown until the AWS watchdog exists.

## Shipped this week

The Work tab shows the newest stored weekly PR report (`shipped` in the feed): the merged count, the newest ten pull requests, the busiest repositories, the summary when Qwen wrote one, and how many repositories were read. The feed carries no PR links. The old reports page still serves `/` until this view is confirmed on staging.
