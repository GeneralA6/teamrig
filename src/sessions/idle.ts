import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { MS_PER_MINUTE, parseDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import type { ParkRules } from '../register/park.ts';
import type { TasksElsewhere } from '../register/tree.ts';
import { asksDecision, messageTextOf } from '../tabs/status.ts';
import { replyOf } from '../turn-log/reply.ts';
import type { WakeAsk } from '../wake/asks.ts';
import { startableTasks } from '../wake/day-start.ts';
import { isNews, type WakeRest } from '../wake/decide.ts';

/**
 * Whether an idle session closes and a closed one reopens, pure (T1100). One rule serves both: a session closes when
 * the wake check would not wake it (src/wake/decide.ts, src/wake/day-start.ts) and reopens when it would, so a closed
 * session comes back exactly when its open tab would get a prompt. A tab still in a turn, at a tool call or putting a
 * decision to the person stays open, and so does one whose own time wait ends soon.
 */

/** A session whose own time wait ends within this many minutes stays open: closing it would only reopen it. */
export const TIME_WAIT_GUARD_MINUTES = 30;

/** Where a tab's last turn stands: ended, still running, at a tool call, or ended on a decision put to the person. */
export type TabActivity = 'idle' | 'turn' | 'call' | 'question';

/** How the lines of a slash command open: Claude Code writes them as user entries, and they start no model turn. */
const LOCAL_COMMAND_TAGS: readonly string[] = ['<command-name>', '<command-message>', '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>'];

/** How the entry Claude Code writes when the person stops a turn opens. */
const INTERRUPTED = '[Request interrupted by user';

function callsTool(entry: JsonRecord): boolean {
  const content = recordField(entry, 'message')?.['content'];
  return Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'tool_use');
}

/** True for an entry of the tab's own turns: the person's or the model's, not meta context, a helper's or a slash command's. */
function isTurnEntry(entry: JsonRecord): boolean {
  if (entry['isMeta'] === true || entry['isSidechain'] === true) {
    return false;
  }
  if (entry['type'] === 'assistant') {
    return true;
  }
  if (entry['type'] !== 'user') {
    return false;
  }
  const text = (messageTextOf(entry) ?? '').trimStart();
  return !LOCAL_COMMAND_TAGS.some((tag) => text.startsWith(tag));
}

/** A transcript tail's lines (`cut`: the tail of a longer file, whose partial first line is skipped). */
function tailLines(text: string, cut: boolean): string[] {
  return text.split('\n').slice(cut ? 1 : 0);
}

/** The last entry of the tab's own turns among `lines`, and its index. */
function lastTurnEntryOf(lines: readonly string[]): { readonly entry: JsonRecord; readonly index: number } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseObject((lines[index] ?? '').trim());
    if (entry !== undefined && isTurnEntry(entry)) {
      return { entry, index };
    }
  }
  return undefined;
}

/**
 * Where the tab's last turn stands, from its transcript's tail (`cut`: the tail of a longer file, whose first line may
 * be partial and is skipped). Its last own entry decides: a model entry calling a tool is at a call (running, or
 * waiting on a permission or an answer), a model reply that puts a decision to the person (`asksDecision`) asks one,
 * any other reply ended the turn; a person's entry (a prompt or a tool's result) is a turn under way, unless it is
 * the person stopping the turn. No entry: idle.
 */
export function tabActivityOf(text: string, cut: boolean): TabActivity {
  const lines = tailLines(text, cut);
  const last = lastTurnEntryOf(lines);
  if (last === undefined) {
    return 'idle';
  }
  const { entry, index } = last;
  if (entry['type'] === 'user') {
    return (messageTextOf(entry) ?? '').startsWith(INTERRUPTED) ? 'idle' : 'turn';
  }
  if (callsTool(entry)) {
    return 'call';
  }
  // Up to this reply only: a slash command run after it starts no turn, so the decision still waits.
  return asksDecision(replyOf(lines.slice(0, index + 1).join('\n'), undefined, !cut)?.text) ? 'question' : 'idle';
}

/**
 * When the tab's last own entry was written, epoch ms, from its transcript's tail (`cut` as for `tabActivityOf`): what
 * a session is quiet since. The file's last change is no measure of it: slash commands, away summaries and meta
 * entries start no turn, and an idle tab's file changes with no entry at all (five idle tabs' transcripts moved
 * together, an hour apart, their sizes unchanged: T1417). Undefined with no own entry in the tail, or a last one with
 * no time.
 */
export function lastTurnAtOf(text: string, cut: boolean): number | undefined {
  const stamp = lastTurnEntryOf(tailLines(text, cut))?.entry['timestamp'];
  const at = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** A time wait of the session's own that ends soon, and its task. */
export interface SoonTimeWait {
  readonly task: Task;
  /** When the wait ends, epoch ms. */
  readonly at: number;
}

/**
 * The soonest time wait of the session's own unfinished tasks within `maxPriority` that ends after `now` and within
 * `TIME_WAIT_GUARD_MINUTES`; undefined when none does.
 */
export function soonTimeWaitOf(tasks: ReadonlyMap<string, Task>, session: string, maxPriority: number, now: number, zone: TimeZone): SoonTimeWait | undefined {
  const until = now + TIME_WAIT_GUARD_MINUTES * MS_PER_MINUTE;
  let soonest: SoonTimeWait | undefined;
  for (const task of tasks.values()) {
    if (task.owner !== session || task.priority > maxPriority || task.status === 'done' || task.status === 'dropped') {
      continue;
    }
    for (const reason of task.waits) {
      const at = reason.kind === 'time' ? parseDeadline(reason.at, zone)?.getTime() : undefined;
      if (at !== undefined && at > now && at <= until && (soonest === undefined || at < soonest.at)) {
        soonest = { task, at };
      }
    }
  }
  return soonest;
}

/** What a closed session's reopen goes by. */
export interface ReopenInput {
  readonly tasks: ReadonlyMap<string, Task>;
  /** The tasks the team tree's other registers hold, which a wait or an `after` may name. */
  readonly elsewhere: TasksElsewhere;
  readonly session: string;
  /** Its urgent lines no wake check has taken (src/wake/asks.ts). */
  readonly asks: readonly WakeAsk[];
  /** When teamrig closed it, epoch ms. */
  readonly closedAt: number;
  /** The least urgent priority that wakes it now (`effectivePriority`). */
  readonly maxPriority: number;
  readonly parking: ParkRules;
  readonly rest: WakeRest;
  /**
   * Its latest day start at or before `now`, epoch ms (src/cli/day-schedule.ts: the tree's schedule, else
   * `wake.dayStartUtc`); undefined: none today.
   */
  readonly dayStart: number | undefined;
  readonly now: number;
  readonly zone: TimeZone;
}

/** Whether a closed session reopens now, and for which urgent lines (`at`: the oldest one's post) or tasks, most urgent first. */
export type ReopenVerdict =
  | { readonly kind: 'asked'; readonly asks: readonly WakeAsk[]; readonly at: number }
  | { readonly kind: 'handed'; readonly tasks: readonly Task[] }
  | { readonly kind: 'day-start'; readonly at: number; readonly tasks: readonly Task[] }
  | { readonly kind: 'stay' };

/**
 * Whether a session teamrig closed reopens now, as the wake check would wake its open tab: for urgent lines posted to
 * it, whatever its rest and at once (each is urgent by its sender's choice, and a pass's closes post theirs together),
 * else for work it can start within `maxPriority` that someone else or the clock changed since it last touched it
 * (`isNews`, so work it saw before the close does not reopen it), else for a day start after its close when it has any
 * work it can start and does not rest (quiet hours, held by its budget). Else it stays closed.
 */
export function reopenVerdict(input: ReopenInput): ReopenVerdict {
  const { tasks, elsewhere, session, now, zone, parking } = input;
  if (input.asks.length > 0) {
    return { kind: 'asked', asks: input.asks, at: Math.min(...input.asks.map((ask) => ask.at)) };
  }
  const handed = startableTasks(tasks, elsewhere, session, now, zone, parking, input.maxPriority).filter((task) => isNews(task, session, tasks, elsewhere, zone));
  if (handed.length > 0) {
    return { kind: 'handed', tasks: handed };
  }
  const { dayStart } = input;
  if (dayStart === undefined || dayStart > now || dayStart <= input.closedAt || input.rest.quiet || input.rest.held) {
    return { kind: 'stay' };
  }
  const startable = startableTasks(tasks, elsewhere, session, now, zone, parking);
  return startable.length === 0 ? { kind: 'stay' } : { kind: 'day-start', at: dayStart, tasks: startable };
}
