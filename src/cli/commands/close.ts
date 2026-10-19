import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { resumeVerdict } from '../../hiring/rehire.ts';
import { endAndWait, tabProcessOf, workCutOffBy, type TabEnder } from '../../open/end-tab.ts';
import { isClaudeProcess, type ProcessInfo } from '../../open/session-processes.ts';
import { readRunningWork } from '../../refresh/running.ts';
import { SessionLog } from '../../sessions/log.ts';
import { measureSessions } from '../../sessions/measure.ts';
import { SessionRecordStore, type SessionRecord } from '../../sessions/record.ts';
import { startableTasks } from '../../wake/day-start.ts';
import { onePositional, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import { lastSessionOf } from './rehire.ts';
import { teamProjectOf } from './setup.ts';

const MINUTE_MS = 60_000;

/** A running session that may be closed: its Claude Code, what that holds, how long it has been quiet. */
interface Closable {
  readonly record: SessionRecord;
  readonly claude: ProcessInfo;
  readonly heldMb: number;
  readonly idleMinutes: number;
}

/** The session's Claude Code process and the MB its tree holds, when it runs; else why it cannot be closed. */
async function runningOf(runtime: CliRuntime, kit: Kit, roster: Roster, id: string, label: string): Promise<{ readonly record: SessionRecord; readonly claude: ProcessInfo; readonly heldMb: number }> {
  // Every session's record: a later one on the same process (a /clear that bound the tab to it) wins it.
  const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
  const record = records.get(id);
  const rows = await runtime.memory.processes();
  if (rows === undefined) {
    throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell whether ${label} runs`);
  }
  const place = measureSessions(records, rows).find((each) => each.id === id);
  const claude = record === undefined ? undefined : await runtime.sessionProcesses.describe(record.claudePid);
  if (record === undefined || place?.state !== 'running' || claude === undefined || !isClaudeProcess(claude)) {
    throw new RefusedError(`${label} is not running: nothing to close`);
  }
  return { record, claude, heldMb: place.treeMb };
}

/**
 * Why `id` stays open, in the order the checks cost: a role that keeps it, not running, work it can start,
 * quiet too briefly, work running in the background, a last session too big or old to resume (v1 has no
 * handover for a close), or shells an end would cut off: each throws its refusal. Else what to close.
 */
async function closableOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string, project: string): Promise<Closable> {
  const label = `${roster.nameOf(id) ?? id} (session ${id})`;
  const kept = roster.rolesOf(id).filter((role) => role === 'lead' || role === 'coordinatorOwner');
  if (kept.length > 0) {
    throw new RefusedError(`${label} holds the ${kept.join(' and ')} role: ${KIT_NAME} never closes it`);
  }
  const { record, claude, heldMb } = await runningOf(runtime, kit, roster, id, label);
  const now = runtime.clock.now();
  const startable = startableTasks((await teamRegister(runtime, kit.paths, config).snapshot()).state.tasks, id, now);
  if (startable.length > 0) {
    throw new RefusedError(`${label} has work it can start (${startable.map((task) => task.id).join(', ')}): close only a session with none`);
  }
  const last = await lastSessionOf(runtime, record.claudeSession, project);
  if (last.changedAt === undefined) {
    throw new RefusedError(`${label} has no transcript of Claude Code session ${record.claudeSession} in ${project}, so its idle time is unknown`);
  }
  const idleMinutes = Math.floor((now - last.changedAt) / MINUTE_MS);
  const needed = config.open.headroom.closeIdleMinutes;
  if (idleMinutes < needed) {
    throw new RefusedError(`${label} has been quiet ${idleMinutes} min; it closes after ${needed} (open.headroom.closeIdleMinutes)`);
  }
  if ((await readRunningWork(runtime.files, last.transcript, now)) > 0) {
    throw new RefusedError(`${label} still runs background work its transcript shows`);
  }
  const resume = resumeVerdict({ claudeSession: record.claudeSession, changedAt: last.changedAt, tokens: last.tokens }, config.hiring, now);
  if (resume.kind === 'fresh') {
    throw new RefusedError(`${label} could not be resumed once closed (${resume.detail}); retire it with its handover instead`);
  }
  const cutOff = await workCutOffBy(enderOf(runtime), claude);
  if (cutOff !== undefined) {
    throw new RefusedError(`${label}: ${cutOff}`);
  }
  return { record, claude, heldMb, idleMinutes };
}

function enderOf(runtime: CliRuntime): TabEnder {
  return { processes: runtime.sessionProcesses, clock: runtime.clock, sleep: runtime.sleep, platform: runtime.platform };
}

/**
 * `close <id|name> --session <lead> [--project <dir>] [--yes]`: (the lead only) ends an idle session's Claude Code
 * and its tab to free the host, and logs the close (`state/session-log.jsonl`); `teamrig open` then resumes its
 * last Claude Code session. It refuses the lead and the coordinator owner, a session not running, one with work it
 * can start, one quiet under `open.headroom.closeIdleMinutes`, one running background work or shells, and one whose
 * last session is too big or old to resume. Without --yes it shows the close and ends nothing.
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
  const project = await teamProjectOf(runtime, args.flags.get('project'), found.from);
  const closable = await closableOf(runtime, kit, config, roster, id, project);
  const what = `${name} (session ${id}): quiet ${closable.idleMinutes} min, its Claude Code holds ${closable.heldMb} MB`;
  if (!args.switches.has('yes')) {
    runtime.out.stdout(`CLOSE ${what}; ${KIT_NAME} open ${name} resumes Claude Code session ${closable.record.claudeSession}. Run again with --yes to close it`);
    return EXIT.ok;
  }
  const ender = enderOf(runtime);
  const problem = await endAndWait(ender, await tabProcessOf(ender, closable.claude), closable.claude.pid);
  if (problem !== undefined) {
    throw new RefusedError(`${name} (session ${id}) was not closed: ${problem}`);
  }
  await new SessionLog(runtime.files, kit.paths.sessionLog).append({
    kind: 'close',
    session: id,
    by,
    at: new Date(runtime.clock.now()).toISOString(),
    claudeSession: closable.record.claudeSession,
    idleMinutes: closable.idleMinutes,
    freedMb: closable.heldMb,
  });
  runtime.out.stdout(`CLOSED ${what}, now free; ${KIT_NAME} open ${name} resumes it`);
  return EXIT.ok;
}
