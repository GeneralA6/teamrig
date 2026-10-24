import { afterOptions, wordsOf, type ProgramRun } from './programs.ts';
import { EXEC_VALUED, NPM_VALUED } from './runners.ts';

/**
 * The heavy steps a command line runs: a test suite or a build, the steps `teamrig heavy` runs under the host
 * lock. The budget's miss count and the heavy guard read them the same way.
 */

export type HeavyStep = 'test' | 'build';

/** Programs that run a test suite or a build themselves. */
const HEAVY_PROGRAMS: ReadonlyMap<string, HeavyStep> = new Map([
  ['tsc', 'build'],
  ['jest', 'test'],
  ['vitest', 'test'],
]);
/** Package scripts that run a test suite: `npm test`, `npm run test:cli`, `pnpm verify`. */
const TEST_SCRIPT = /^(?:test|t|tst|verify|check|coverage)(?::\S*)?$/;
/** Package scripts that run a build: `npm run build`, `pnpm typecheck`, `yarn lint`. */
const BUILD_SCRIPT = /^(?:build|typecheck|lint)(?::\S*)?$/;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);
/** Options that make a program print its version or usage and stop, running no test or build. */
const PRINT_ONLY_OPTIONS: ReadonlySet<string> = new Set(['--version', '--help']);

/**
 * True when a tool's words only print its version or usage: `tsc --version`, `npx vitest --help`; words after a `--`
 * belong to what the tool runs. Not read for a package manager: pnpm and yarn hand the words after a script's name
 * to the script, so `pnpm run build --version` still builds.
 */
function printsOnly(words: readonly string[]): boolean {
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).some((word) => PRINT_ONLY_OPTIONS.has(word));
}

function scriptStep(script: string | undefined): HeavyStep | undefined {
  if (TEST_SCRIPT.test(script ?? '')) {
    return 'test';
  }
  return BUILD_SCRIPT.test(script ?? '') ? 'build' : undefined;
}

/**
 * The heavy step a run is: `npm test`, `node --test`, `npx vitest run` test; `npm run build`, `tsc` build; else
 * undefined, also for a tool that only prints its version or usage.
 */
export function heavyStepOf(run: ProgramRun): HeavyStep | undefined {
  const words = wordsOf(run);
  const program = HEAVY_PROGRAMS.get(run.name);
  if (program !== undefined) {
    return printsOnly(words) ? undefined : program;
  }
  if (run.name === 'node') {
    return words.includes('--test') && !printsOnly(words) ? 'test' : undefined;
  }
  if (run.name === 'npx') {
    const tool = afterOptions(words, EXEC_VALUED);
    return printsOnly(tool) ? undefined : HEAVY_PROGRAMS.get(tool[0] ?? '');
  }
  if (!PACKAGE_MANAGERS.has(run.name)) {
    return undefined;
  }
  const [command, script] = afterOptions(words, NPM_VALUED);
  return scriptStep(command === 'run' || command === 'run-script' ? script : command);
}
