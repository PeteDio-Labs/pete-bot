# Lab dashboard

A Preact single-page app on toonish-ui v0.3.0 that shows what needs you, the alerts and their triage, the CVE report,
the service switch panel with a watchdog per side, and the Plane summary. Mobile first, WCAG 2.2 AA.

## Commands

| Command | Does |
|---|---|
| `bun install` | Installs Preact, the kit and the test tools |
| `bun run build` | Writes `dist/` and fails when an output is missing |
| `bun run dev` | Builds, then serves `dist/` on `http://localhost:8090` |
| `bun test` | Tests the model and the feed |
| `bun run typecheck` | Runs `tsc --noEmit` |
| `bun run test:a11y` | Runs axe on 5 tabs, 4 feed states and 2 widths, and prints what it read |

## How it works

- **One feed.** `src/data.ts` exposes `Feed`. The page reads `<meta name="dashboard-feed">`, set at build time with
  `DASHBOARD_FEED`, and defaults to `/fixtures/dashboard.json`. Moving the feed to another host changes that value, not a view.
- **Unknown is not healthy.** `src/model.ts` turns a missing, malformed or older-than-5-minutes record into `unknown`. A
  section that does not parse is dropped and listed in a banner.
- **Every view says what it read,** with counts and the age of the read.
- **The switch toggle only asks (a labelled `role="switch"`, checked when the service runs in the cloud; a tap opens a confirm step).** `DASHBOARD_SWITCH` names a URL that queues a request. Without it, the button is
  disabled and says why. A switch is allowed only when the target side is fresh and healthy, and a service with a
  database needs a known replication lag.
- **Tabs belong to the kit.** `toonish-ui/toonish.js` switches the panels by hash. Preact leaves `hidden` alone.

## Data

The fixture holds synthetic values and example hostnames. Staging serves it and reads nothing from the lab.

## The AWS API (`api/`)

One Lambda (`nodejs22.x`, arm64, handler `handler.handler`) and one DynamoDB table `dash`. The header of
`api/handler.ts` lists the routes and keys. `bun run build:api` writes `api/dist/handler.mjs`, with the AWS SDK left
to the runtime. The function never stamps a check time, refuses a watchdog record dated in the future, and records a
switch request without moving anything. Tests use an in-memory table.
