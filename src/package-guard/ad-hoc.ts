import type { Files } from '../core/files.ts';
import { resolveDir } from '../push-guard/location.ts';
import { hasLocalBin } from './local-bin.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from './programs.ts';
import { runnerCallOf, type RunnerCall } from './runners.ts';

/**
 * The ad-hoc package runs in a command line: each runner call that fetches a package, or that runs a bin not
 * installed where it runs (so the runner would fetch one). A habit guard, not a security boundary: a line built
 * at run time (`eval "$X"`) or a runner started by another program is not seen.
 */

/** A runner call that may fetch a package: the others run nothing (`none`) or hand their flag to npm (`lost-flag`). */
type MayFetchCall = Extract<RunnerCall, { readonly kind: 'fetch' | 'bin' }>;

/** True when `call` would fetch: always for a `fetch`, and for a `bin` not installed where it runs or in a folder only known then. */
async function fetches(files: Files, run: ProgramRun, call: MayFetchCall, home: string): Promise<boolean> {
  if (call.kind === 'fetch') {
    return true;
  }
  const prefix = call.prefix;
  const dir = prefix === undefined ? run.dir : prefix.dynamic ? undefined : resolveDir(run.dir, prefix.text, home);
  return dir === undefined || !(await hasLocalBin(files, dir, call.bin));
}

/** The ad-hoc runner calls `command` makes, each once, as they show in a refusal (`npx eslint`). */
export async function adHocCallsOf(command: string, context: ProgramsContext, files: Files): Promise<string[]> {
  const calls = new Set<string>();
  for (const run of programsOf(command, context)) {
    const call = runnerCallOf(run);
    if ((call.kind === 'fetch' || call.kind === 'bin') && (await fetches(files, run, call, context.home))) {
      calls.add(call.call);
    }
  }
  return [...calls];
}
