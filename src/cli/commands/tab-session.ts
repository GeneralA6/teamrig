import type { Roster } from '../../config/roster.ts';
import { ENV } from '../../core/home.ts';
import { resolveTeam } from '../../core/team.ts';
import type { ParsedArgs } from '../args.ts';
import { sessionRef } from '../inputs.ts';
import { openKit, rosterOf, sessionIdOf, teamFolders, type Kit } from '../kit.ts';
import { RefusedError, type CliRuntime } from '../runtime.ts';
import { envSession, markedSessionOf } from './hook-input.ts';

/**
 * The session a command runs as: `--session` or `$TEAMRIG_SESSION`, else the session this Claude Code tab is bound
 * to; undefined when neither names one. A tab bound to a session runs only as that session, so naming another one
 * there is refused; `own` says what a session does only as itself, such as `withdraws only its own steps`.
 */
export async function tabSessionOf(args: ParsedArgs, runtime: CliRuntime, kit: Kit, roster: Roster, own: string): Promise<string | undefined> {
  const named = args.flags.get('session') ?? envSession(runtime);
  const bound = await markedSessionOf(runtime, kit, roster, runtime.env[ENV.claudeSession]?.trim() ?? null);
  if (named === undefined) {
    return bound;
  }
  const session = sessionIdOf(roster, sessionRef('--session', named));
  if (bound !== undefined && bound !== session) {
    throw new RefusedError(`this tab is ${bound}'s: a session ${own}, not ${session}'s`);
  }
  return session;
}

/**
 * Refuses a write that names, by `--session` or `$TEAMRIG_SESSION`, a session other than the one this Claude Code tab
 * is bound to (T3082), so a session's writes, its approvals and audits too, carry its own name. run.ts calls it for
 * every write before the command loads, so no command can miss it. It checks nothing outside a Claude Code tab (no
 * `$CLAUDE_CODE_SESSION_ID`: the owner's own shell), in a tab bound to no session yet, or where no team is found or
 * its config does not load: a command that needs the team refuses those itself. It rests on the tab's binding.
 */
export async function refuseAnotherTabSession(args: ParsedArgs, runtime: CliRuntime): Promise<void> {
  const named = args.flags.get('session') ?? envSession(runtime);
  const claudeSession = runtime.env[ENV.claudeSession]?.trim();
  if (named === undefined || claudeSession === undefined || claudeSession === '') {
    return;
  }
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime, [runtime.cwd]));
  if (found.kind !== 'team') {
    return;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return;
  }
  const roster = await rosterOf(runtime, kit, kit.load.config);
  const bound = await markedSessionOf(runtime, kit, roster, claudeSession);
  if (bound === undefined) {
    return;
  }
  const lookup = roster.lookup(sessionRef('--session', named));
  const session = lookup.ok ? lookup.id : named;
  if (session !== bound) {
    throw new RefusedError(`this tab is ${bound}'s: a session runs teamrig's writes only as itself, not as ${session}`);
  }
}
