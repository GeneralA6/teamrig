import type { LocalCheck } from './local-gate.ts';

/** TypeScript's compiler, run by this Node (npm cannot be spawned without a shell on Windows). */
const TSC = 'node_modules/typescript/bin/tsc';

/** The base the commit checks compare with when `--base` is not given. */
export const DEFAULT_BASE = 'origin/main';

/**
 * Every check CI runs on a pull request, in the order the local gate runs them (fast ones first). The
 * coverage gate runs the whole test suite, so `npm test` is not repeated; `npm run build` is its three steps, run
 * before the suite, whose specs load the built plugin.
 * Unlike CI, it runs on one machine and one Node: a failure only another OS or Node shows goes unseen. It also
 * runs the plugin's own tests (its mod's engine specs) in the Claude Code installed here, which CI does not.
 */
export function localChecks(base: string): readonly LocalCheck[] {
  return [
    ...commitChecks(base),
    TYPECHECK,
    BOUNDARIES,
    PROVIDER_WORDS,
    ...BUILD,
    { name: 'coverage gate', argv: ['node', 'tools/ci/coverage-cli.ts'] },
    { name: 'dist smoke', argv: ['node', 'tools/ci/dist-smoke-cli.ts'] },
    { name: 'fresh install', argv: ['node', 'tools/ci/fresh-install-cli.ts'] },
    // After the build: the mod's hooks load the built dist.
    PLUGIN_TESTS,
    ...DOC_CHECKS,
  ];
}

/**
 * The light checks (check-scope.ts, T4344), about 45 s: the pre-push hook's proof of a branch whose main merges only
 * on GitHub's required checks, which run the rest (the whole suite with its coverage gate, the dist checks and the
 * fresh install) on every OS before anything lands. Each is the full list's own entry. They build the dist, as the
 * plugin's tests load it and main tracks none (T4355): a fresh checkout has no dist until a build writes it, and
 * the written one is ignored by git, so the checkout stays clean. The hook runs `teamrig secrets pushed` before them.
 */
export function prePushChecks(base: string): readonly LocalCheck[] {
  return [
    ...commitChecks(base),
    TYPECHECK,
    BOUNDARIES,
    PROVIDER_WORDS,
    ...BUILD,
    PLUGIN_TESTS,
    ...DOC_CHECKS,
  ];
}

const TYPECHECK: LocalCheck = { name: 'typecheck', argv: ['node', TSC, '-p', 'tsconfig.json'] };

/** The layer boundaries of `src`, counted in under a second; in warn mode it fails only when it cannot read the tree. */
const BOUNDARIES: LocalCheck = { name: 'boundaries', argv: ['node', 'tools/ci/boundaries-cli.ts'] };
/** The host and tool words in each skill, counted in under a second; it fails when a count rose over its baseline. */
const PROVIDER_WORDS: LocalCheck = { name: 'provider words', argv: ['node', 'tools/ci/provider-words-cli.ts'] };

/** `npm run build`'s three steps: the dist cleared, compiled and its integrity list written. */
const BUILD: readonly LocalCheck[] = [
  { name: 'build: clean', argv: ['node', 'tools/build/clean.ts'] },
  { name: 'build: compile', argv: ['node', TSC, '-p', 'tsconfig.build.json'] },
  { name: 'build: integrity', argv: ['node', 'tools/build/integrity.ts'] },
];

/** The plugin's own tests, in an empty home: no account, settings or other plugins. */
const PLUGIN_TESTS: LocalCheck = { name: 'plugin tests', argv: ['claude', 'plugin', 'test', 'plugins/teamrig'], isolatedHome: true };

/** The checks that hold the docs to the code: the pictures, the configuration reference, the parity page and the links. */
const DOC_CHECKS: readonly LocalCheck[] = [
  { name: 'doc pictures', argv: ['node', 'tools/docs/images-cli.ts', '--check'] },
  { name: 'doc config reference', argv: ['node', 'tools/docs/configuration-cli.ts', '--check'] },
  { name: 'doc parity page', argv: ['node', 'tools/docs/parity-cli.ts', '--check'] },
  { name: 'doc links', argv: ['node', 'tools/docs/doc-check-cli.ts'] },
];

/** The scrub of the tree, then the scrub and the DCO sign-off of the commits since the base, their size and subjects. */
function commitChecks(base: string): readonly LocalCheck[] {
  return [...signedScrubbed(base), ...commitShape(base)];
}

/** The scrub of the tree, then the scrub and the DCO sign-off of the commits since the base. */
function signedScrubbed(base: string): readonly LocalCheck[] {
  const range = `${base}..HEAD`;
  return [
    { name: 'scrub: tree', argv: ['node', 'tools/scrub/cli.ts', '--tree'] },
    { name: 'scrub: commits', argv: ['node', 'tools/scrub/cli.ts', '--range', range] },
    { name: 'DCO', argv: ['node', 'tools/dco/cli.ts', '--range', range] },
  ];
}

/**
 * The size rule and the commit subjects of the commits since the base. Each takes under a second, and a miss found
 * only at CI means a rewritten, re-pushed branch, so a short proof runs them too (security's condition C1, T4080).
 */
function commitShape(base: string): readonly LocalCheck[] {
  return [
    { name: 'size rule', argv: ['node', 'tools/ci/size-rule-cli.ts', '--base', base] },
    { name: 'commit subjects', argv: ['node', 'tools/ci/commit-subjects-cli.ts', '--base', base] },
  ];
}

/**
 * The short checks (check-scope.ts, T3414): the commit checks (scrub, DCO sign-off, size and subjects), the typecheck
 * and the given specs, for a branch whose main merges only on GitHub's required checks, which run the whole suite on
 * the pull request. The pre-push hook runs `teamrig secrets pushed` before them. With no spec to run, the specs' check
 * is left out.
 */
export function shortChecks(base: string, specs: readonly string[]): readonly LocalCheck[] {
  const checks = [...commitChecks(base), TYPECHECK];
  return specs.length === 0 ? checks : [...checks, { name: 'changed specs', argv: ['node', '--test', ...specs] }];
}

/**
 * The paths whose change makes a short proof run every check (security's condition C2, T4080): the gate itself (its
 * hooks, CI workflows, local and ship tools, the push guard) and what every spec depends on (the package, its lockfile
 * and the TypeScript configs). A change there can break a spec no changed file sits beside, or the gate that would
 * find it, so the short set proves too little.
 */
const GATE_PATHS: readonly RegExp[] = [
  /^\.githooks\//,
  /^\.github\//,
  /^tools\/ci\//,
  /^tools\/ship\//,
  /^src\/push-guard\//,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
];

/** The changed paths that change the gate itself (GATE_PATHS), in the order given. */
export function gateChanges(changed: readonly string[]): string[] {
  return changed.filter((path) => GATE_PATHS.some((pattern) => pattern.test(path)));
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
