# wp2jx — agent notes

wp2jx migrates Cwicly WordPress sites to Jx projects. Read `docs/design.md` (source facts, target facts, mapping rules, both fixture sites) and `src/types.ts` (module contracts) before writing code.

## Working rules

- TypeScript on Bun, strict, `exactOptionalPropertyTypes` (use conditional spreads for optional props), `noUncheckedIndexedAccess`. ESM with explicit `.ts` import specifiers.
- Tests: `bun test --isolate <paths>` only. Test files live in `tests/<area>/*.test.ts`, mirror `src/`, and use **real data**: `tests/helpers/fixture-db.ts` (`fixtureDb("fineline" | "ap")` gives a SQLite URL over the committed rows), `tests/fixtures/<site>/css/*.css`, `tests/fixtures/<site>/html/*.html` (rendered pages, the ground truth). Never invent block markup or CSS when a real fixture exists; never mock the `@jxsuite/*` packages. Hand-written inputs are fine for edge cases a fixture lacks.
- Typecheck: `bunx tsc --noEmit`. Other modules are being written concurrently, so errors in files you do not own are not yours; every error in your own files is. Lint: `bunx oxlint <your paths>`. Format your own files only: `bunx oxfmt <your paths>`.
- Do not run `bun add`/`bun remove` (parallel installs corrupt `package.json`). Everything likely to be needed is installed; if something is missing, say so in your report.
- Do not edit `src/types.ts`, `docs/design.md`, or any file you were not assigned. If a contract needs to change, say so in your report and work around it locally.
- Do not run git commands that change state (no add/commit/stash/checkout/reset).
- The throwaway MariaDB with both source databases may be running at `mysql://root@127.0.0.1:3399/{s212682_fineline,s142094_anabapti}` (start it with `scripts/dev-db.sh start`). Use it only for the optional live-database checks; unit tests must run on the fixture SQLite files.
- Network: the live sites (https://finelinepainting.pro, https://anabaptistperspectives.org) may be fetched for investigation, never from unit tests.
- Comments explain why, in the voice of the code around them; no change-log comments, no "added for X".
- Every divergence from the Jx specs, every Jx bug you work around, and every unconverted feature goes in the report or the code's migration report, never silently.
- **The machine is shared and was overloaded twice (the editor hosting this session crashed).** Never run the whole suite or `bun test` without paths: run only your own test files (`bun test --isolate <your paths>`). Prefix anything long or CPU-heavy with `nice -n 10`. Keep throwaway scripts light, never leave a server, a browser or a watcher running when you finish, and run at most one browser at a time. Roughly seven agents work at once.
- Write your files in small, saved steps (one Write or Edit per coherent piece) rather than one enormous final write: a crash restarts you from the files on disk, so unsaved work is lost work.
- **A full `jx build` of the finelinepainting pilot with its 755 real images took 44 minutes of wall time (98 CPU minutes, 1.1 GB of dist) because Jx optimises every image.** Never trigger it casually and never in a loop. For iteration use a build without image optimisation or with a light `images` config (the stabilise task measures what is possible and records the recommended setting in the report; check `docs/fidelity-log.md` and src/jx.ts), serve a previous dist/ where only the HTML/CSS matters, or build a subset of pages. Whoever measures should record numbers in the report.
