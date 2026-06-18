# GitTools Worker

**Runtime contract:** CommonJS, synchronous, **zero external dependencies** (Node core only).
Everything is `git` invocation + file I/O + text/JSON, all of which is in Node's standard
library, so there is nothing to `npm install`.

## Layout

```
index.js              Omnis entrypoint (the only Omnis-coupled file): exports
                      call(method, param, response); maps method -> op, runs it,
                      replies via omnis_calls.
src/
  core.js             run(request) -> response. Pure dispatcher, no Omnis/stdout coupling.
  constants.js        Result / ErrorCodes / GitToolsError.
  context.js          createContext(request) -> Context (per-invocation state).
  git.js              spawnSync git wrapper (maxBuffer, per-call env/index/work-tree).
  meta.js             meta.json read/write + clean/pending shapes.
  handoff.js          pending-op.json read/write/clear (pre -> post boundary).
  log.js              level-aware logger (debug | info | warning | error).
  operations/         Omnis-facing operation implementations.
test/                 node:test e2e suites (one file per behaviour), driving run() in-process.
test-support/         helpers.js — shared suite helpers (kept out of test/ so the
                      no-argument `node --test` does not run it as an empty test file).
```

## The Omnis call contract

Omnis invokes `call(method, param, response)`:

- **method** — the operation. The library lifecycle ops: `pre-export` | `post-export` |
  `pre-import` | `post-import`. Plus two context-free discovery ops used at registration:
  `resolveRepositoryRoot` | `checkGitExecutable`.
- **param** — the request payload. Accepted as an object, a JSON string, or a
  single-element array wrapping either (Omnis commonly sends stringified JSON). The lifecycle
  ops carry:
  `{ jsonPath, libraryId, libraryPath, metaPath?, allowMissingBase?, cleanIrrelevantKeys?, config? }`.
  `jsonPath` is absolute; the worker derives the repository root from it (Omnis no longer passes
  it in). `resolveRepositoryRoot` takes `{ jsonPath, config? }` and returns
  `{ repositoryRoot: <abs path> | '' }` (`''` = not a git repository); `checkGitExecutable`
  takes `{ config? }` and returns `{ valid, version }`.
- **response** — Omnis's response handle; the result is sent back via `omnis_calls`.

The worker always replies (HTTP 200) with `run()`'s JSON result object; `omnis_calls.sendError`
(500) is used only for an unexpected crash. So Omnis branches on the payload, not the status:

```
success: { ok: true,  op, result?: 'clean'|'conflict'|'missing-base', source?: <abs path>, log }
failure: { ok: false, op, error: { code, message }, log }
```

Per-phase success shape: `pre-export -> {source}` (cache dir to export into) or
`{result:'missing-base'}`; `post-export -> {result}`; `pre-import -> {source}` (path to
import from); `post-import -> {result:'clean'}`. This is the structured equivalent of the
prototype's `SOURCE=`/`RESULT=` stdout lines — the line-scraping disappears.

`log` is always present on both shapes: an array of `{ level, message }` records the operation
produced, in order. Every level is included unfiltered (Omnis filters when it re-emits them to
its IDE trace log); `logLevel` only governs the worker's own stderr verbosity, not this set.
The records accumulate as the operation runs, so a controlled failure still carries whatever it
logged before the error.

`omnis_calls` is provided by the Omnis runtime; it is not in this repo and is not
require-able outside Omnis. That is fine: `index.js` is the only file that needs it, and
the tests drive `src/core.js`'s `run()` directly.

## Configuration

GitTools config (set by the user in the Omnis library) is passed **in the request** as a
`config` object — Omnis owns the config and hands the worker explicit values, so the
worker never parses Omnis's storage format:

```
config: {
  gitPath?:  string,   // path to the git executable; default "git" (resolved on PATH)
  logLevel?: "debug" | "info" | "warning" | "error"   // default "info"
}
```

`createContext` turns this into `ctx.git` (a runner bound to `gitPath` + the repo cwd; see
`git.js`) and `ctx.log` (a level-aware logger; see `log.js`). Phases use those rather than
reaching for a global or hard-coding `"git"`. If you later prefer the worker to read
Omnis's config file directly, only `createContext` step 1 changes (read+parse the file into
the same `config` object) — nothing downstream is affected.

The logger's sink is injectable (defaults to stderr). The Omnis integration can swap in a
sink that forwards to Omnis's own logging or collects messages into the response.

## Testing strategy

The e2e suites in `test/` use Node's built-in test runner (`node:test` + `node:assert`,
zero dependencies). Each suite drives the worker the way Omnis does — in-process via
`run(request)` from `src/core.js`, with per-library state located through
`createContext(request)` — against throwaway temp repositories. `test-support/helpers.js`
holds the shared drivers (`newRepo`, `exportLib`, `importLib`, state/ref lookups). These are
ports of the original PowerShell e2e suites that validated the `scripts_proto/*.ps1` prototype.

Each suite is named for the behaviour it covers (`reconcile-merge`, `conflict-resolution`,
`staging`, `merge-base-from-history`, `missing-base-gate`, `discard-live-edits`,
`crash-recovery`, `worktree-isolation`).

```
npm test                                      # node --test, auto-discovers test/*.test.js
node --test test/conflict-resolution.test.js  # a single suite
```

## Conventions / constraints

- **CommonJS** (`require` / `module.exports`) — required by the Omnis worker loader (see
  `../example_worker/`), and the safe choice for the older bundled Node.
- **Conservative syntax** — no `?.` / `??` / top-level `await`; unprefixed core requires
  (`require('child_process')`, not `'node:child_process'`) — so it runs on old Node too.
- **`maxBuffer`** is raised to 256 MB in `git.js`: batched git output on a large library
  exceeds the ~1 MB default and would otherwise be silently truncated.
- State scoping mirrors the prototype: mutable state per-worktree, base lineage shared.

## To verify against the real Omnis build

- `child_process` is available in the worker (so `git.js`'s `spawnSync` works).
- `process.version` of the bundled Node — then tighten `engines` in `package.json`.
- How Omnis passes `param` (object vs JSON string vs array) — `parsePayload` in `index.js`
  handles all three, but confirm which one your Omnis side sends.
