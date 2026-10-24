import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import type { Task } from '../../register/fold.ts';
import { waitSpelling } from '../../register/waits.ts';
import { SessionLog } from '../../sessions/log.ts';
import { DECISION_MARKER } from '../../tabs/status.ts';
import { validAsksOf, WakeAsks, type StoredWakeAsk } from '../../wake/asks.ts';
import { onePositional, requiredFlag, type ParsedArgs } from '../args.ts';
import { closeSession } from '../close-session.ts';
import { closableText, idleFactsOf, type Closable, type IdleFacts, type IdleVerdict } from '../idle-check.ts';
import { judgeSession, reopeningText, runningVerdictOf, type JudgedStep, type ReopenWish } from '../idle-pass.ts';
import { formatIdlePassRecord, type IdleActRecord } from '../idle-pass-log.ts';
import { openKit, requireConfig, rosterOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { idFlag, openSession } from './open.ts';

/** Who the session log names as the closer of a session the idle pass closed. */
export const IDLE_PASS_CLOSER = 'idle-pass';

/** The session's verdict and the facts it was weighed on, or the error that kept it from being weighed (the host's processes not listed, say). */
async function verdictOf(
  runtime: CliRuntime,
  kit: Kit,
  config: KitConfig,
  roster: Roster,
  id: string,
  project: string,
): Promise<{ readonly kind: 'weighed'; readonly verdict: IdleVerdict; readonly facts: IdleFacts } | { readonly kind: 'failed'; readonly error: string }> {
  try {
    const facts = await idleFactsOf(runtime, kit, config, roster);
    return { kind: 'weighed', verdict: await runningVerdictOf(runtime, kit, config, roster, facts, id, project), facts };
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/** `decision:owner (T3, T7), approval:lead (T5)`: what the session's tasks wait on from a person, each with its tasks. */
export function personWaitsOf(tasks: ReadonlyMap<string, Task>, id: string): string[] {
  const byWait = new Map<string, string[]>();
  for (const task of tasks.values()) {
    if (task.owner !== id) {
      continue;
    }
    for (const reason of task.waits) {
      if (reason.kind === 'decision' || reason.kind === 'approval') {
        const spelling = waitSpelling(reason);
        byWait.set(spelling, [...(byWait.get(spelling) ?? []), task.id]);
      }
    }
  }
  return [...byWait].map(([spelling, ids]) => `${spelling} (${ids.join(', ')})`);
}

/**
 * The lead's urgent line on a close (owner, 10-24): which session closed and why, what its tasks wait on, and the ask
 * to list the decisions waiting on the owner, ending with the line that turns the lead's tab blue, so the owner, back
 * to fewer tabs, finds them all at the lead.
 */
export function closeNoticeText(label: string, closable: Closable, waits: readonly string[]): string {
  const reopens = waits.length === 0 ? 'no task of it waits on a decision or an approval; work handed to it reopens it' : `its tasks wait on ${waits.join(', ')}; an answer recorded in the register reopens it`;
  return `the idle pass closed ${label}, ${closableText(closable)}; ${reopens}. List the decisions waiting on the owner, ending with a "${DECISION_MARKER}" line.`;
}

/**
 * `idle-close <id> --team <team> --project <dir>`: one close the idle pass decided (T1100), which the pass starts
 * hidden, since ending a tab takes up to about 20 s and the mod ends a wake check at 30. Work may have reached the
 * session since the pass, so it weighs it again as the pass does (`runningVerdictOf`): kept, it ends nothing; else it
 * ends its Claude Code and its tab and logs the close by `idle-pass` (`closeSession`), then posts the lead an urgent
 * line on it (`closeNoticeText`). It runs unseen, so each outcome is a line in the pass log, with the host's commit
 * charge before and after a close, and a lead not told; exit 1 when it could not weigh the session or did not close
 * one it found closable. The pass reads `open.idle.mode` before it starts one, so this does not.
 */
export async function idleClose(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const project = requiredFlag(args.flags, 'project');
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const label = `${roster.nameOf(id) ?? id} (session ${id})`;
  const act = { kind: 'act', mode: config.open.idle.mode, act: 'close', id } as const;
  const weighed = await verdictOf(runtime, kit, config, roster, id, project);
  const unmeasured = { before: undefined, after: undefined };
  if (weighed.kind === 'failed') {
    return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'failed', line: `FAILED to weigh ${label}: ${weighed.error}` });
  }
  const { verdict, facts } = weighed;
  if (verdict.kind === 'keep') {
    return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'kept', line: `KEPT ${verdict.why}` });
  }
  const before = await runtime.memory.commit();
  const problem = await closeSession(runtime, kit.paths, { id, by: IDLE_PASS_CLOSER, closable: verdict.closable });
  const done = { ...act, at: runtime.clock.now(), before, after: await runtime.memory.commit() };
  if (problem !== undefined) {
    return report(runtime, kit, { ...done, outcome: 'failed', line: `FAILED to close ${label}: ${problem}` });
  }
  const lead = config.roles.lead;
  const notice = closeNoticeText(label, verdict.closable, personWaitsOf(facts.tasks, id));
  // The close happened: a lead not told is said in the log, never a failed close.
  const untold = await postUrgentLine(runtime, kit, config, { to: lead, from: KIT_NAME, text: notice });
  const told = untold === undefined ? '' : `; ${lead} not told: ${untold}`;
  return report(runtime, kit, { ...done, outcome: 'done', line: `CLOSED ${label}: ${closableText(verdict.closable)}, now free${told}` });
}

/** The session judged alone, as the pass judges each, or the error that kept it from being weighed. */
async function stepOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string, project: string): Promise<JudgedStep | { readonly kind: 'failed'; readonly error: string }> {
  try {
    const closes = (await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records;
    return await judgeSession(runtime, kit, config, roster, await idleFactsOf(runtime, kit, config, roster), id, async () => project, closes);
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/** Why a session the pass would have reopened stays as it is now. */
function stayText(step: Exclude<JudgedStep, ReopenWish>): string {
  switch (step.kind) {
    case 'close':
    case 'keep':
      return 'it is running';
    case 'closed':
      return 'still closed, nothing it can start';
    case 'away':
      return `not running, and ${KIT_NAME} did not close it`;
  }
}

/**
 * `idle-open <id> --team <team> --project <dir>`: one reopen the idle pass decided (T1100) of a session teamrig
 * closed, which the pass starts hidden, since the room check and the tab take seconds. The session may have been
 * opened, or its work done, since the pass, so it judges it again as the pass does (`judgeSession`): kept, it opens
 * nothing; else it opens it as `teamrig open` does (`openSession`: in its last Claude Code session when that is small
 * and recent enough, else fresh, the reopen logged), and keeps it closed when the host has no room. The urgent lines
 * posted while it was closed are quoted in its first prompt and, once its tab opened, taken, so its tab's wake check
 * does not wake it on them again; kept closed, they wait for the next pass. Each outcome is a line in the pass log,
 * with the host's commit charge before a reopen (its Claude Code takes a while to load, so a charge right after says
 * nothing); exit 1 when it could not weigh the session or no terminal opened.
 */
export async function idleOpen(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const project = requiredFlag(args.flags, 'project');
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const label = `${roster.nameOf(id) ?? id} (session ${id})`;
  const act = { kind: 'act', mode: config.open.idle.mode, act: 'reopen', id } as const;
  const unmeasured = { before: undefined, after: undefined };
  const step = await stepOf(runtime, kit, config, roster, id, project);
  if (step.kind === 'failed') {
    return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'failed', line: `FAILED to weigh ${label}: ${step.error}` });
  }
  if (step.kind !== 'wish') {
    return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'kept', line: `KEPT ${label}: ${stayText(step)}` });
  }
  const measured = { before: await runtime.memory.commit(), after: undefined };
  const why = reopeningText(step.reopening, teamZone(config, runtime));
  const asks = new WakeAsks(runtime.files, kit.paths.wakeAsks);
  try {
    const stored = await asks.read(id);
    const opened = await openSession(runtime, kit, config, roster, { team, id, project, terminal: config.open.terminal, asked: false, urgent: validAsksOf(stored) });
    const done = { ...act, ...measured, at: runtime.clock.now() };
    if (opened.kind !== 'opened') {
      return report(runtime, kit, { ...done, outcome: 'failed', line: `FAILED to reopen ${label}: no terminal opened (${opened.reasons.join('; ')})` });
    }
    const untaken = await untakenText(asks, id, stored);
    return report(runtime, kit, { ...done, outcome: 'done', line: `REOPENED ${label} for ${why}: ${opened.line}${untaken}` });
  } catch (error) {
    // A refusal here is the host's room, read fresh: the next pass tries again.
    const kept = error instanceof RefusedError;
    return report(runtime, kit, { ...act, ...measured, at: runtime.clock.now(), outcome: kept ? 'kept' : 'failed', line: kept ? `KEPT ${label} closed: ${error.message}` : `FAILED to reopen ${label}: ${errorMessage(error)}` });
  }
}

/**
 * Takes the asks a reopened tab's first prompt quotes; what the REOPENED line adds when they stay, '' once taken. The
 * tab opened, so a failure here is said, never a failed reopen: its wake check wakes it on them once more.
 */
async function untakenText(asks: WakeAsks, id: string, stored: readonly StoredWakeAsk[]): Promise<string> {
  try {
    await asks.remove(id, stored);
    return '';
  } catch (error) {
    return `; its urgent lines were not taken, so its tab wakes on them once more: ${errorMessage(error)}`;
  }
}

/**
 * Logs the act and prints its line; exit 1 when it failed. A log it cannot write is said, but is no reason to fail a
 * close that already happened.
 */
async function report(runtime: CliRuntime, kit: Kit, record: IdleActRecord): Promise<ExitCode> {
  try {
    await runtime.files.append(kit.paths.idlePassLog, formatIdlePassRecord(record));
  } catch (error) {
    runtime.out.stderr(`WARN the idle pass log was not written: ${errorMessage(error)}`);
  }
  runtime.out.stdout(record.line);
  return record.outcome === 'failed' ? EXIT.failed : EXIT.ok;
}
