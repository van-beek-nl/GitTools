# GitTools Worker

The GitTools export/import reconciliation engine, as an Omnis Studio JavaScript worker.
Replaces the PowerShell prototype in `../scripts_proto/` so non-Windows users need no
manual PowerShell install — Omnis ships its own Node.

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
  git.js              [done] git() / runGit() — spawnSync wrapper (maxBuffer, per-call env).
  errors.js           [done] Result / Op / ErrorCodes / GitToolsError.
  context.js          [stub] createContext(request) -> Context (per-invocation state).
  phases/
    preExport.js      [stub]  ─┐
    postExport.js     [stub]   │ one per phase; each throws NOT_IMPLEMENTED with a
    preImport.js      [stub]   │ checklist pointing at the matching .ps1 to port.
    postImport.js     [stub]  ─┘
  cli.js              [done] test-only adapter: argv -> run() -> SOURCE=/RESULT= + exit code.
```

## The Omnis call contract

Omnis invokes `call(method, param, response)`:

- **method** — the operation: `pre-export` | `post-export` | `pre-import` | `post-import`.
- **param** — the request payload. Accepted as an object, a JSON string, or a
  single-element array wrapping either (Omnis commonly sends stringified JSON). It carries:
  `{ repoRoot, jsonPath, libraryId, libraryPath, metaPath?, allowMissingBase?, config? }`.
- **response** — Omnis's response handle; the result is sent back via `omnis_calls`.

The worker always replies (HTTP 200) with `run()`'s JSON result object; `omnis_calls.sendError`
(500) is used only for an unexpected crash. So Omnis branches on the payload, not the status:

```
success: { ok: true,  op, result?: 'clean'|'conflict'|'missing-base', source?: <abs path> }
failure: { ok: false, op, error: { code, message } }
```

Per-phase success shape: `pre-export -> {source}` (cache dir to export into) or
`{result:'missing-base'}`; `post-export -> {result}`; `pre-import -> {source}` (path to
import from); `post-import -> {result:'clean'}`. This is the structured equivalent of the
prototype's `SOURCE=`/`RESULT=` stdout lines — the line-scraping disappears.

`omnis_calls` is provided by the Omnis runtime; it is not in this repo and is not
require-able outside Omnis. That is fine: `index.js` is the only file that needs it, and
tests drive `src/core.js` / `src/cli.js` instead.

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

`cli.js` re-emits the old `SOURCE=`/`RESULT=` stdout protocol so the existing PowerShell
e2e suites can drive this worker as a drop-in for the `.ps1` scripts once the phases are
ported — point the suites' script invocations at `node src/cli.js <op> --repo-root … …`
for behavioural parity against the prototype. (The unit-level PS suites that dot-source
prototype functions will need small JS equivalents.)

Smoke check (run inside a real Omnis worker first, to confirm `child_process` is allowed
and git is reachable):

```
npm run smoke        # prints "node <version>" and "git version <…>"
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

- `child_process` is available in the worker (the smoke check settles it).
- `process.version` of the bundled Node — then tighten `engines` in `package.json`.
- How Omnis passes `param` (object vs JSON string vs array) — `parseParam` in `index.js`
  handles all three, but confirm which one your Omnis side sends.

## Porting status

Plumbing done (`git`, `errors`, `core`, `cli`, `index`). Domain logic stubbed: port
`scripts_proto/common.ps1` into `context.js` plus focused modules (suggested seams: a git
helper layer already exists; add `meta`, `refs`, `cache`, `trees`, `merge`, `reconcile`),
then fill the four `phases/*`.
