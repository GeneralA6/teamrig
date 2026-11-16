import type { LocalCheck } from './local-gate.ts';

/** TypeScript's compiler, run by this Node (npm cannot be spawned without a shell on Windows). */
const TSC = 'node_modules/typescript/bin/tsc';

/** The base the commit checks compare with when `--base` is not given. */
export const DEFAULT_BASE = 'origin/main';

/**
 * Every check CI runs on a pull request, in the order the local gate runs them (fast ones first). The
 * coverage gate runs the whole test suite, so `npm test` is not repeated; `npm run build` is its three steps.
 * Unlike CI, it runs on one machine and one Node: a failure only another OS or Node shows goes unseen. It also
 * runs the plugin's own tests (its mod's engine specs) in the Claude Code installed here, which CI does not.
 */
export function localChecks(base: string): readonly LocalCheck[] {
  const [scrubTree, scrubCommits, dco] = commitChecks(base);
  return [
    scrubTree,
    scrubCommits,
    dco,
    { name: 'size rule', argv: ['node', 'tools/ci/size-rule-cli.ts', '--base', base] },
    { name: 'plugin version gate', argv: ['node', 'tools/ci/plugin-version-cli.ts', '--base', base] },
    TYPECHECK,
    { name: 'coverage gate', argv: ['node', 'tools/ci/coverage-cli.ts'] },
    { name: 'build: clean', argv: ['node', 'tools/build/clean.ts'] },
    { name: 'build: compile', argv: ['node', TSC, '-p', 'tsconfig.build.json'] },
    { name: 'build: integrity', argv: ['node', 'tools/build/integrity.ts'] },
    { name: 'dist matches the source', argv: ['node', 'tools/ci/dist-fresh-cli.ts'] },
    { name: 'dist smoke', argv: ['node', 'tools/ci/dist-smoke-cli.ts'] },
    // After the build: the mod's hooks load the built dist. An empty home: no account, settings or other plugins.
    { name: 'plugin tests', argv: ['claude', 'plugin', 'test', 'plugins/teamrig'], isolatedHome: true },
    { name: 'doc pictures', argv: ['node', 'tools/docs/images-cli.ts', '--check'] },
    { name: 'doc config reference', argv: ['node', 'tools/docs/configuration-cli.ts', '--check'] },
    { name: 'doc links', argv: ['node', 'tools/docs/doc-check-cli.ts'] },
  ];
}

const TYPECHECK: LocalCheck = { name: 'typecheck', argv: ['node', TSC, '-p', 'tsconfig.json'] };

/** The scrub of the tree, then the scrub and the DCO sign-off of the commits since the base. */
function commitChecks(base: string): readonly [LocalCheck, LocalCheck, LocalCheck] {
  const range = `${base}..HEAD`;
  return [
    { name: 'scrub: tree', argv: ['node', 'tools/scrub/cli.ts', '--tree'] },
    { name: 'scrub: commits', argv: ['node', 'tools/scrub/cli.ts', '--range', range] },
    { name: 'DCO', argv: ['node', 'tools/dco/cli.ts', '--range', range] },
  ];
}

/**
 * The short checks (check-scope.ts, T3414): the scrub, the DCO sign-off, the typecheck and the given specs, for a
 * branch whose main merges only on GitHub's required checks, which run the whole suite on the pull request. The
 * pre-push hook runs `teamrig secrets pushed` before them. With no spec to run, the specs' check is left out.
 */
export function shortChecks(base: string, specs: readonly string[]): readonly LocalCheck[] {
  const checks = [...commitChecks(base), TYPECHECK];
  return specs.length === 0 ? checks : [...checks, { name: 'changed specs', argv: ['node', '--test', ...specs] }];
}

const SPEC = /\.test\.ts$/;
/** A file's extension, the last dot of its name on; a name with no dot has none. */
const EXTENSION = /\.[^./]+$/;

/**
 * The specs of the changed files, sorted, each once: a changed spec, and the `<stem>.test.ts` beside any other changed
 * file `<stem>.<ext>` (so `repos.json` brings `repos.test.ts`), each only when it exists in the tree.
 */
export function changedSpecs(changed: readonly string[], exists: (path: string) => boolean): string[] {
  const specs = changed.map((path) => (SPEC.test(path) ? path : path.replace(EXTENSION, '.test.ts')));
  return [...new Set(specs.filter((path) => SPEC.test(path) && exists(path)))].sort();
}
