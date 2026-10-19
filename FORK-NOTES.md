# Fork notes — engineering hardening

This repository is a **tracking fork** of
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). Upstream is canonical:
product behaviour, releases, downloads and issue tracking stay there. This fork follows upstream
`main` and only adds the guardrails below, so the delta stays reviewable and easy to drop if the
changes are offered upstream.

## What changed

| Area | Change | Why |
| --- | --- | --- |
| Lint | `biome.json` + `bun run lint` / `lint:fix` (`@biomejs/biome` 2.4.4) | The repository had no linter at all. The first run found a duplicated `./input-tokens` import, implicit-`any` `let` bindings on parsed JSON, assignments inside expressions, `do…while (true)` polling loops, and `forEach` callbacks returning values. |
| Types | `noUnusedLocals` and `noUnusedParameters` in `tsconfig.json` | Dead parameters/imports were invisible: one unused import pair, one unused completion-tracker parameter chained through the browser worker, two unused test bindings. |
| Verification | `bun run lint` joined `scripts/verify.ts` | Local `bun run verify` and CI now run the same gate, so lint cannot drift from the tested path. |
| CI supply chain | Every workflow action pinned to a full commit SHA with the tag in a trailing comment | Mutable tags (`@v4`, `@v6`) are a supply-chain risk in a project that handles ChatGPT session cookies and tunnel credentials. |
| CI | `dependency-review` job on pull requests (fails on high severity) | Rejects vulnerable dependency upgrades before merge. |
| CI | `.github/workflows/codeql.yml` (CodeQL, `security-and-quality` queries, push/PR/weekly) | No SAST existed. Fork PRs are excluded from code-scanning upload, matching GitHub's read-only token rule for forks. |
| CI | `.github/dependabot.yml` for `bun` (root and `launcher/`) and `github-actions` | Security updates used to rely on manual `overrides` edits. Minor/patch updates are grouped; majors stay individual. |
| Coverage | `bun run test:coverage` | Makes the existing suite measurable (baseline below) without adding a failing gate that would need a ratchet first. |
| Fork hygiene | `package.json` `repository`/`homepage` point at this fork; `bugs` still points upstream | Metadata previously advertised upstream as the source of this checkout. |
| Docs | Fork notice in `README.md`; security reporting in `SECURITY.md` corrected (the repository is public, so the "once public" wording was stale) | Users must not confuse this fork with the canonical project. |
| Fix | `src/adapters/chatgpt-web/browser-worker.ts` duplicate `./input-tokens` import merged | Dead duplication caught by review; also the clearest example of what a linter would have caught. |
| Localization | **pt-BR language pack**: `languages.json` entry (`Português (Brasil)`, marker `PT`, locale `pt-BR`), 232 UI strings in `launcher/src/i18n.ts`, 59 Limits strings in `launcher/src/limits-copy.ts`, 14 native tray/dialog strings in `launcher/electron/main.cjs` | The launcher shipped en, zh-CN, zh-TW, ja and ko only. `Language` is derived from `languages.json`, so the new locale participates in onboarding, Settings, tray and native dialogs. |
| Browser E2E | `scripts/e2e-launcher.ts` + `bun run e2e:launcher --port <cdpPort>` | Nothing exercised the real Electron renderer in a browser. The script attaches over CDP with Playwright and verifies every page, every locale (including pt-BR), the doctor IPC round-trip, reload persistence, the embedded ChatGPT surface, and renderer console/page errors. |

## Intentional lint exceptions

Two rules are disabled in `biome.json` because the current behaviour is deliberate. Both stay
visible in review; neither hides a failure:

- `correctness/noUnsafeFinally` — the browser turn intentionally escalates launcher control errors
  from its `finally` block. The inner `catch` keeps the original failure when one exists
  (`browser-worker.ts`, `runBrowserTurn` tail), and the smoke/DEV cleanup paths rethrow to attach
  diagnostics. Restructuring those paths is a behaviour change that belongs in its own PR.
- `style/noNonNullAssertion` — 201 occurrences, dominant in DOM-contract tests where a fixture is
  known to exist. Converting them is pure churn today.

Everything else in Biome's recommended set is enforced as an error.

## Measured baseline (2026-10-19, this host)

Commands run from the repository root with Bun 1.4.0:

```
bun run typecheck     # exit 0
bun run lint          # 0 errors (137 warnings, 94 infos)
bun test ./tests      # 999 pass, 73 skip, 0 fail — 1072 tests / 78 files
bun run test:coverage # all files: 77.38% lines, 75.46% functions
```

`bun test` needs the `launcher/` dependencies installed, because several root tests import
`launcher/electron/browser-host.cjs`, which requires `electron`. Run
`bun install --frozen-lockfile` in both directories (as CI does), and make sure Electron's
postinstall actually downloaded its binary; otherwise three Zero Risk compaction tests fail with
`Electron failed to install correctly`.

## Browser E2E (real Electron renderer)

The launcher exposes a loopback CDP port (`launcher.window_created.cdpPort` in
`<dev-home>/launcher/logs/launcher.jsonl`), so the renderer can be driven like a web page:

```bash
# terminal 1 — isolated DEV profile, your normal profiles are untouched
cd launcher && bun run dev
# terminal 2 — attach and verify
bun run e2e:launcher --port <cdpPort>
```

Latest run (2026-10-19, Windows): `E2E_LAUNCHER OK (17 passed, 0 failed)` — six pages, six
locales including pt-BR, doctor IPC round-trip, reload persistence, embedded `chatgpt.com` surface,
and no renderer console/page errors. Screenshots land in `.e2e-launcher/` (git-ignored).

A real turn also completed end-to-end during validation: the launcher's own browser smoke test
(`smoke.started` → `smoke.completed {effort: "Luna", responseChars: 19}`) ran against ChatGPT
Temporary Chat in the isolated DEV profile. It used an anonymous temporary session — no account
login, no user prompt, no personal data — so it proves the browser submission/streaming path but
does not replace the account-bound Full-harness release validation.

Two environment notes:

- `ELECTRON_RUN_AS_NODE=1` in the shell makes Electron start as plain Node and the launcher dies
  with `Cannot read properties of undefined (reading 'getPath')`. Unset it before `bun run dev`.
- The embedded ChatGPT page logs its own CSP/third-party errors; the E2E only asserts on the
  launcher renderer, which is the surface this fork owns.

## Upstream invariants worth knowing

- `launcher/tests/localization.test.cjs` requires every locale README (`README.zh-CN.md`,
  `README.ja.md`, `README.ko.md`) to keep exactly the same command fences and link targets as
  `README.md`. The fork notice therefore had to be added to all four READMEs; adding a link to the
  English README only fails `bun run launcher:test`. This was hit and fixed while validating this
  change.
- `bun run verify` is the single gate CI runs: version check, lint, dependency audits, both
  typechecks, both test suites, launcher build, runtime bundle, third-party notices and the release
  smoke test.

## Next steps (not done here)

1. `noUncheckedIndexedAccess` — currently 22 type errors; adopt with a focused PR that adds explicit
   bounds handling instead of non-null assertions.
2. Coverage ratchet — record the current per-file numbers and fail the build when a touched file
   drops more than a fixed delta.
3. Formatter adoption — Biome's formatter is left disabled on purpose: reformatting ~95k lines would
   bury the security and reliability delta and complicate future upstream merges.
4. Blocking `bun audit` on production dependencies only (today it audits the full graph, including
   dev tooling).
5. Upstream contribution path — the highest-value reliability fixes are tracked upstream and are
   better sent as small PRs than carried in this fork:
   [#854](https://github.com/miuuyy/codex-chatgpt-web/issues/854) (helper takeover duplicates a
   running turn), [#858](https://github.com/miuuyy/codex-chatgpt-web/issues/858) (approval clicked
   while the reply is still streaming), [#861](https://github.com/miuuyy/codex-chatgpt-web/issues/861)
   (missing trusted `cwd` after compaction), [#622](https://github.com/miuuyy/codex-chatgpt-web/issues/622)
   (safety blocks are invisible in diagnostics).

## Not published

This working tree is local only: nothing was committed, tagged or pushed. Review with `git diff` and
`git status` before deciding what to keep.
