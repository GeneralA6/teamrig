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
  const range = `${base}..HEAD`;
  return [
    { name: 'scrub: tree', argv: ['node', 'tools/scrub/cli.ts', '--tree'] },
    { name: 'scrub: commits', argv: ['node', 'tools/scrub/cli.ts', '--range', range] },
    { name: 'DCO', argv: ['node', 'tools/dco/cli.ts', '--range', range] },
    { name: 'plugin version gate', argv: ['node', 'tools/ci/plugin-version-cli.ts', '--base', base] },
    { name: 'typecheck', argv: ['node', TSC, '-p', 'tsconfig.json'] },
    { name: 'coverage gate', argv: ['node', 'tools/ci/coverage-cli.ts'] },
    { name: 'build: clean', argv: ['node', 'tools/build/clean.ts'] },
    { name: 'build: compile', argv: ['node', TSC, '-p', 'tsconfig.build.json'] },
    { name: 'build: integrity', argv: ['node', 'tools/build/integrity.ts'] },
    { name: 'dist matches the source', argv: ['node', 'tools/ci/dist-fresh-cli.ts'] },
    { name: 'dist smoke', argv: ['node', 'tools/ci/dist-smoke-cli.ts'] },
    // After the build: the mod's hooks load the built dist. An empty home: no account, settings or other plugins.
    { name: 'plugin tests', argv: ['claude', 'plugin', 'test', 'plugins/teamrig'], isolatedHome: true },
    { name: 'doc pictures', argv: ['node', 'tools/docs/images-cli.ts', '--check'] },
    { name: 'doc links', argv: ['node', 'tools/docs/doc-check-cli.ts'] },
  ];
}
