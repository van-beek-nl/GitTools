// Thin CLI adapter. NOT used in production - Omnis calls run() via index.js directly.
// Its purpose is to let the existing PowerShell e2e suites drive this Node worker as a
// drop-in for the .ps1 phase scripts: it maps argv -> run(request) -> the SOURCE=/RESULT=
// stdout contract and a 0/non-zero exit code, exactly as the prototype scripts behave.
//
//   node src/cli.js --self-check [--git-path <p>]
//   node src/cli.js pre-export --repo-root <p> --json-path <p> --library-id <id> --library-path <p> \
//        [--git-path <p>] [--log-level debug|info|warning|error] [--allow-missing-base]

const { run } = require('./core.js');
const { createGit } = require('./git.js');

const BOOLEAN_FLAGS = new Set(['allow-missing-base', 'self-check']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        out[key] = true;
      } else {
        out[key] = argv[++i];
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function buildConfig(args) {
  const config = {};
  if (args['git-path']) { config.gitPath = args['git-path']; }
  if (args['log-level']) { config.logLevel = args['log-level']; }
  return config;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Smoke check: proves the worker can spawn the configured git and reports both versions.
  // Run this first inside an actual Omnis worker to confirm child_process is available.
  if (args['self-check']) {
    const git = createGit({ gitPath: args['git-path'] });
    process.stdout.write('node ' + process.version + '\n');
    process.stdout.write(git.version() + '\n');
    return 0;
  }

  const request = {
    operation: args._[0] || args.operation,
    repoRoot: args['repo-root'],
    jsonPath: args['json-path'],
    libraryId: args['library-id'],
    libraryPath: args['library-path'],
    metaPath: args['meta-path'],
    allowMissingBase: Boolean(args['allow-missing-base']),
    config: buildConfig(args),
  };

  const res = run(request);
  if (!res.ok) {
    process.stderr.write(res.error.code + ': ' + res.error.message + '\n');
    return 1;
  }
  // Mirror the prototype's machine-readable stdout protocol.
  if (typeof res.source === 'string') { process.stdout.write('SOURCE=' + res.source + '\n'); }
  if (typeof res.result === 'string') { process.stdout.write('RESULT=' + res.result + '\n'); }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // run() returns structured errors, but the --self-check path calls git directly;
  // convert any throw into a clean message + non-zero exit rather than a raw stack.
  const code = err && err.code ? err.code + ': ' : '';
  process.stderr.write(code + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
}
