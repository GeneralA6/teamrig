import { programsOf, type ProgramsContext } from './programs.ts';
import { runnerCallOf } from './runners.ts';

/** An npx call whose bin never gets the flag after it: npm takes it (see the `lost-flag` RunnerCall). */
export interface LostFlag {
  readonly bin: string;
  readonly flag: string;
}

/** The npx calls in `command` that hand their bin's flag to npm, each once. Like the ad-hoc read, it sees only this line. */
export function lostFlagsOf(command: string, context: ProgramsContext): LostFlag[] {
  const lost = new Map<string, LostFlag>();
  for (const run of programsOf(command, context)) {
    const call = runnerCallOf(run);
    if (call.kind === 'lost-flag') {
      lost.set(`${call.bin} ${call.flag}`, { bin: call.bin, flag: call.flag });
    }
  }
  return [...lost.values()];
}
