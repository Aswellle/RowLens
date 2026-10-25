# Contributing to RowLens

Thanks for considering a contribution. RowLens is a small, focused tool:
a local-only CSV/TSV/JSONL viewer and cleaning workbench. Contributions that
keep it small and focused are the ones that land.

## Ground rules

- **Local-only is a hard boundary.** No network requests carrying user data,
  no telemetry, no accounts, no remote fonts or CDN runtime scripts. Any
  change that adds a fetch/XHR/WebSocket/sendBeacon fails the network audit
  in CI.
- **Data correctness beats convenience.** Values stay strings by default;
  no implicit numeric or date conversion. Parsing and export behaviour is
  contract-tested — changes need matching test updates
  (`docs/03-data-processing-contracts.md` is the source of truth; update it
  first when behaviour changes).
- **No heavy dependencies.** The dependency list is deliberately short
  (React, Vite, Papa Parse, TanStack Virtual, test tooling). Propose the
  benefit and the alternatives before adding one.
- **Source files are read-only.** Cleaning is a serializable pipeline applied
  in-memory; the app never writes back to an imported file.

## Development

```bash
npm ci            # reproducible install (Node >= 22.12)
npm run dev       # Vite dev server
npm run typecheck # tsc --noEmit, strict
npm run test:unit # Vitest unit & component tests
npm run build     # typecheck + production build
npm run format    # Prettier (also run format:check before pushing)
```

Browser tests: `npx playwright test` (Chromium bundle, or
`PLAYWRIGHT_CHANNEL=msedge|chrome npx playwright test` with an installed
browser). The performance suite is gated: `PERF=1` and results go to
`docs/performance-results.md` only from real runs.

## Pull requests

1. Branch from `main`; keep the change minimal and described in the PR body.
2. Every behavioural change ships with tests (unit, and browser E2E when the
   behaviour is user-visible).
3. `npm run typecheck && npm run test:unit && npm run build` must pass, plus
   `npx playwright test` for UI-facing changes.
4. Accessibility matters: interactive changes need keyboard operability and,
   where relevant, an axe scan (`e2e/a11y.spec.ts` is the baseline — no
   critical or serious violations).
5. Architecture decisions go in `docs/decisions.md` (ADR format, append-only).

## Reporting issues

Open a GitHub issue with the browser/OS, the smallest synthetic reproduction
file you can build (never attach real data), and the observed vs expected
behaviour. For security-sensitive reports see `SECURITY.md`.
