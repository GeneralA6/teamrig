import { KIT_NAME } from '../core/home.ts';
import { resolveTeam } from '../core/team.ts';
import type { ParsedArgs } from './args.ts';
import { openKit, rosterOf, teamFolders } from './kit.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * `--session` and `--team` on a command that takes neither for its own use (#654): every command reads both
 * (`COMMON_FLAGS`, args.ts), since sessions name themselves out of habit. Such a command ignores `--session` once it
 * names a session of the folder's team (by id, current or former name), and runs for that team only, so a `--team`
 * naming another is refused with one line. With no team found here a `--session` is not checked: there is no roster to
 * check it against, and the command reports the missing team itself when it needs one. A config that does not load
 * leaves the check to the command too, so `doctor` and `config validate` still run on a broken one. `runCli` calls it
 * only when one of the two is given to a command that does not declare it.
 */
export async function checkCommonFlags(command: string, declared: readonly string[], args: ParsedArgs, runtime: CliRuntime): Promise<void> {
  const session = declared.includes('session') ? undefined : args.flags.get('session');
  const team = declared.includes('team') ? undefined : args.flags.get('team');
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
  const own = found.kind === 'team' ? found.team : undefined;
  if (team !== undefined && team !== own) {
    const here = own === undefined ? 'the team of this folder, and none is found here' : `this folder's team (${own}) only`;
    throw new RefusedError(`${KIT_NAME} ${command} runs for ${here}; --team ${team} names another team`);
  }
  if (session === undefined || own === undefined) {
    return;
  }
  const kit = await openKit(runtime, own);
  if (kit.load.status !== 'loaded') {
    return;
  }
  if (!(await rosterOf(runtime, kit, kit.load.config)).lookup(session).ok) {
    throw new RefusedError(`--session ${session} names no session of team ${own}: ${KIT_NAME} who lists them`);
  }
}
