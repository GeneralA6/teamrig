import { claudeProjectsDir, projectTranscriptPath } from '../budget/discover.ts';
import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import { resumeVerdict } from '../hiring/rehire.ts';
import { workCutOffBy, type TabEnder } from '../open/end-tab.ts';
import { isClaudeProcess, type ProcessInfo } from '../open/session-processes.ts';
import { readRunningWork } from '../refresh/running.ts';
import type { Task } from '../register/fold.ts';
import { soonTimeWaitOf, tabActivityOf, TIME_WAIT_GUARD_MINUTES, type TabActivity } from '../sessions/idle.ts';
import { measureSessions, type SessionPlace } from '../sessions/measure.ts';
import { SessionRecordStore, type SessionRecord } from '../sessions/record.ts';
import { REPLY_TAIL_BYTES } from '../turn-log/reply.ts';
import { startableTasks } from '../wake/day-start.ts';
import { measureTranscript } from './commands/rehire.ts';
import { teamZone, type Kit } from './kit.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';
import { teamRegister } from './team-register.ts';

const MINUTE_MS = 60_000;

/** A running session that may be closed: its Claude Code, what that holds and committed, how long it has been quiet. */
export interface Closable {
  readonly record: SessionRecord;
  readonly claude: ProcessInfo;
  readonly heldMb: number;
  /** Undefined where the host does not say. */
  readonly committedMb: number | undefined;
  readonly idleMinutes: number;
}

/** `quiet <n> min, its Claude Code holds <MB> MB[, <MB> MB committed]`, as close and the idle pass print it. */
export function closableText(closable: Closable): string {
  const committed = closable.committedMb === undefined ? '' : `, ${closable.committedMb} MB committed`;
  return `quiet ${closable.idleMinutes} min, its Claude Code holds ${closable.heldMb} MB${committed}`;
}

/** Whether a session closes, and what; else why it stays open, as a sentence naming it. */
export type IdleVerdict = { readonly kind: 'close'; readonly closable: Closable } | { readonly kind: 'keep'; readonly why: string };

/** What every session's verdict reads, read once for all of them. */
export interface IdleFacts {
  /** Every session's record: a later one on the same process (a /clear that bound the tab to it) wins it. */
  readonly records: ReadonlyMap<string, SessionRecord | undefined>;
  readonly places: readonly SessionPlace[];
  readonly tasks: ReadonlyMap<string, Task>;
  readonly now: number;
  readonly zone: TimeZone;
}

/**
 * How a verdict weighs work: the least urgent priority that keeps a session open, and the folder it resumes in,
 * where a session whose record names no transcript has it.
 */
export interface IdleOptions {
  readonly maxPriority: number;
  readonly project: string;
}

/** Why a tab's last turn keeps it open, by where it stands. */
const ACTIVITY_CLAUSES: Readonly<Record<Exclude<TabActivity, 'idle'>, string>> = {
  turn: 'is in a turn',
  call: 'is at a tool call (running, or waiting on a permission or an answer)',
  question: 'put a decision to the person and waits for the answer',
};

/** The facts for every session of the roster; refuses when the host's processes cannot be listed. */
export async function idleFactsOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster): Promise<IdleFacts> {
  const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
  const rows = await runtime.memory.processes();
  if (rows === undefined) {
    throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell which sessions run`);
  }
  const tasks = (await teamRegister(runtime, kit.paths, config).snapshot()).state.tasks;
  return { records, places: measureSessions(records, rows), tasks, now: runtime.clock.now(), zone: teamZone(config, runtime) };
}

/**
 * Whether `id` closes, with the checks in the order they cost: a role or open.idle.keepOpen that keeps it, not running in the host's
 * process list, work it can start within `maxPriority`, a time wait of its own ending soon, quiet too briefly, a turn
 * not ended (under way, at a tool call, or a decision put to the person), work running in the background, a last
 * session too big or old to resume (v1 has no handover for a close), its process no longer a Claude Code, or shells
 * an end would cut off. The first that holds keeps it open. The last two look at the host's processes one by one
 * (about a second each on Windows), so only a session every other check would close pays for them.
 */
export async function idleVerdictOf(runtime: CliRuntime, config: KitConfig, roster: Roster, facts: IdleFacts, id: string, options: IdleOptions): Promise<IdleVerdict> {
  const label = `${roster.nameOf(id) ?? id} (session ${id})`;
  const keep = (why: string): IdleVerdict => ({ kind: 'keep', why: `${label} ${why}` });
  const notRunning = 'is not running: nothing to close';
  const kept = roster.rolesOf(id).filter((role) => role === 'lead' || role === 'coordinatorOwner');
  if (kept.length > 0) {
    return keep(`holds the ${kept.join(' and ')} role: ${KIT_NAME} never closes it`);
  }
  if (config.open.idle.keepOpen.includes(id)) {
    return keep(`is in open.idle.keepOpen: ${KIT_NAME} never closes it`);
  }
  const record = facts.records.get(id);
  const place = facts.places.find((each) => each.id === id);
  if (record === undefined || place?.state !== 'running') {
    return keep(notRunning);
  }
  const { now, zone, tasks } = facts;
  const startable = startableTasks(tasks, id, now, zone, options.maxPriority);
  if (startable.length > 0) {
    return keep(`has work it can start (${startable.map((task) => task.id).join(', ')})`);
  }
  const soon = soonTimeWaitOf(tasks, id, options.maxPriority, now, zone);
  if (soon !== undefined) {
    return keep(`waits until ${zone.clock(new Date(soon.at))} on ${soon.task.id}, under ${TIME_WAIT_GUARD_MINUTES} min away`);
  }
  const transcript = record.transcript ?? projectTranscriptPath(claudeProjectsDir(runtime.env, runtime.userHome), options.project, record.claudeSession);
  const last = await measureTranscript(runtime, transcript);
  if (last.changedAt === undefined) {
    return keep(`has no transcript of Claude Code session ${record.claudeSession} at ${transcript}, so its idle time is unknown`);
  }
  const idleMinutes = Math.floor((now - last.changedAt) / MINUTE_MS);
  const needed = config.open.headroom.closeIdleMinutes;
  if (idleMinutes < needed) {
    return keep(`has been quiet ${idleMinutes} min; it closes after ${needed} (open.headroom.closeIdleMinutes)`);
  }
  const tail = (await runtime.files.readTail(last.transcript, REPLY_TAIL_BYTES)) ?? '';
  const activity = tabActivityOf(tail, Buffer.byteLength(tail, 'utf8') >= REPLY_TAIL_BYTES);
  if (activity !== 'idle') {
    return keep(ACTIVITY_CLAUSES[activity]);
  }
  if ((await readRunningWork(runtime.files, last.transcript, now)) > 0) {
    return keep('still runs background work its transcript shows');
  }
  const resume = resumeVerdict({ claudeSession: record.claudeSession, changedAt: last.changedAt, tokens: last.tokens }, config.hiring, now);
  if (resume.kind === 'fresh') {
    return keep(`could not be resumed once closed (${resume.detail}); retire it with its handover instead`);
  }
  const claude = await runtime.sessionProcesses.describe(record.claudePid);
  if (claude === undefined || !isClaudeProcess(claude)) {
    return keep(notRunning);
  }
  const cutOff = await workCutOffBy(enderOf(runtime), claude);
  if (cutOff !== undefined) {
    return { kind: 'keep', why: `${label}: ${cutOff}` };
  }
  return { kind: 'close', closable: { record, claude, heldMb: place.treeMb, committedMb: place.committedMb, idleMinutes } };
}

/** What ends a session's tab and checks what that would cut off, from the runtime. */
export function enderOf(runtime: CliRuntime): TabEnder {
  return { processes: runtime.sessionProcesses, clock: runtime.clock, sleep: runtime.sleep, platform: runtime.platform };
}
