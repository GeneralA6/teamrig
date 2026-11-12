import { KIT_NAME } from '../../core/home.ts';
import { onePositional, type ParsedArgs } from '../args.ts';
import { closeSession } from '../close-session.ts';
import { closableText, idleFactsOf, idleVerdictOf } from '../idle-check.ts';
import { restCappedPriority } from '../idle-pass.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { sessionProjectOf } from './setup.ts';

/**
 * `close <id|name> --session <lead> [--project <dir>] [--yes]`: (the lead only) ends an idle session's Claude Code
 * and its tab to free the host, and logs the close (`state/session-log.jsonl`); `teamrig open` then resumes its
 * last Claude Code session. It refuses what `idleVerdictOf` keeps open (src/cli/idle-check.ts): the lead and the
 * delivery owner, a session not running, one with work its budget lets it start (p0 only while its budget holds
 * or a short day pauses it, p1 and p0 in the budget's quiet hours, p0 alone when they block: `restCappedPriority`) or a time wait of its own
 * ending soon, one quiet under `open.headroom.closeIdleMinutes`, one in a turn, at a tool call or waiting on a
 * decision it put to the person, one running background work or shells, and one whose last session is too big or old
 * to resume.
 * Without --yes it shows the close and ends nothing.
 */
export async function close(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = onePositional(args, 'id|name');
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const by = sessionIdOf(roster, callerOf(args.flags, runtime.env));
  if (by !== roster.holderOf('lead')) {
    throw new RefusedError('only the lead closes a session');
  }
  const id = sessionIdOf(roster, target);
  const name = roster.nameOf(id) ?? id;
  const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
  const facts = await idleFactsOf(runtime, kit, config, roster);
  const maxPriority = await restCappedPriority(runtime, kit, config, roster, facts.tasks, id, Number.POSITIVE_INFINITY);
  const verdict = await idleVerdictOf(runtime, config, roster, facts, id, { maxPriority, project });
  if (verdict.kind === 'keep') {
    throw new RefusedError(verdict.why);
  }
  const { closable } = verdict;
  const what = `${name} (session ${id}): ${closableText(closable)}`;
  if (!args.switches.has('yes')) {
    runtime.out.stdout(`CLOSE ${what}; ${KIT_NAME} open ${name} resumes Claude Code session ${closable.record.claudeSession}. Run again with --yes to close it`);
    return EXIT.ok;
  }
  const problem = await closeSession(runtime, kit.paths, { id, by, closable });
  if (problem !== undefined) {
    throw new RefusedError(`${name} (session ${id}) was not closed: ${problem}`);
  }
  runtime.out.stdout(`CLOSED ${what}, now free; ${KIT_NAME} open ${name} resumes it`);
  return EXIT.ok;
}
