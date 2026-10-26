import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { numberField, stringField } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { costText, idsText, wakePrompt, wakeToast, type WakeCost } from './decide.ts';

/**
 * A timed ask's terms (`inbox add --wake-by`, T1148): it wakes its receiver at `at`, epoch ms, and only when the
 * receiver had not seen the posted inbox line by then, found by the line's hash (src/inbox/line-hash.ts).
 */
export interface WakeBy {
  readonly at: number;
  readonly line: string;
}

/**
 * A line that wakes the session it is for at its tab's next wake check, as work handed to it does: who posted it,
 * what it says (the wake's prompt quotes it) and when, epoch ms. It is posted beside the plain inbox line, which stays
 * the record; the ask only makes that line wake its receiver. A timed ask (`by`) waits for its time first.
 */
export interface WakeAsk {
  readonly from: string;
  readonly text: string;
  readonly at: number;
  readonly by?: WakeBy;
}

/**
 * The format of a plain ask's file, which an older teamrig reads as well; one in another format, or damaged, reads as
 * no ask and goes at the next check.
 */
export const WAKE_ASK_FORMAT = 1;

/** The format of a timed ask's file (T1148): a plain ask's fields, and `dueAt` and `line` for its `by`. */
export const TIMED_ASK_FORMAT = 2;

export function formatWakeAsk(ask: WakeAsk): string {
  const plain = { from: ask.from, text: ask.text, at: ask.at };
  return ask.by === undefined
    ? toJsonlLine({ [VERSION_FIELD]: WAKE_ASK_FORMAT, ...plain })
    : toJsonlLine({ [VERSION_FIELD]: TIMED_ASK_FORMAT, ...plain, dueAt: ask.by.at, line: ask.by.line });
}

/** An ask file's content; undefined when it is damaged or from another format. */
export function parseWakeAsk(text: string): WakeAsk | undefined {
  const record = parseObject(text.trim());
  const format = record?.[VERSION_FIELD];
  if (record === undefined || (format !== WAKE_ASK_FORMAT && format !== TIMED_ASK_FORMAT)) {
    return undefined;
  }
  const from = stringField(record, 'from');
  const said = stringField(record, 'text');
  const at = numberField(record, 'at');
  if (from === undefined || said === undefined || at === undefined) {
    return undefined;
  }
  if (format === WAKE_ASK_FORMAT) {
    return { from, text: said, at };
  }
  const dueAt = numberField(record, 'dueAt');
  const line = stringField(record, 'line');
  return dueAt === undefined || line === undefined ? undefined : { from, text: said, at, by: { at: dueAt, line } };
}

/** An ask as stored: its file's name, and the ask, undefined when the file is damaged or from another format. */
export interface StoredWakeAsk {
  readonly name: string;
  readonly ask: WakeAsk | undefined;
}

/** `<at>-<n>.json`: the post time, then a count that keeps two asks posted in one millisecond apart. */
const ASK_FILE = /^(\d+)-(\d+)\.json$/;

/** The most asks one session gets in one millisecond; past it a post fails rather than look on for a free name. */
export const ASKS_PER_MS = 100;

/** The post time and count of an ask file's name; undefined for any other file (a write's temporary sibling). */
function orderOf(name: string): readonly [number, number] | undefined {
  const match = ASK_FILE.exec(name);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

/** The folder that holds the session's asks, which an idle tab of the session watches (src/mod/wake-hand.ts). */
export function asksFolderOf(folder: string, id: string): string {
  return join(folder, id);
}

/**
 * Each session's asks, one file each (`<id>/<at>-<n>.json`), created whole (`createExclusive`), so a check that
 * takes the asks it read never takes, nor loses, one posted meanwhile. Ids are session ids, checked by the roster, so
 * they are safe in a path.
 */
export class WakeAsks {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, folder: string) {
    this.files = files;
    this.folder = folder;
  }

  async post(id: string, ask: WakeAsk): Promise<void> {
    const text = formatWakeAsk(ask);
    for (let n = 0; n < ASKS_PER_MS; n += 1) {
      if (await this.files.createExclusive(join(asksFolderOf(this.folder, id), `${ask.at}-${n}.json`), text)) {
        return;
      }
    }
    throw new Error(`${id} already has ${ASKS_PER_MS} asks posted at ${new Date(ask.at).toISOString()}`);
  }

  /** The session's asks, oldest first. */
  async read(id: string): Promise<readonly StoredWakeAsk[]> {
    const named = (await this.files.list(asksFolderOf(this.folder, id))).flatMap((name) => {
      const order = orderOf(name);
      return order === undefined ? [] : [{ name, order }];
    });
    named.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    const stored: StoredWakeAsk[] = [];
    for (const { name } of named) {
      const text = await this.files.read(join(asksFolderOf(this.folder, id), name));
      if (text !== undefined) {
        stored.push({ name, ask: parseWakeAsk(text) });
      }
    }
    return stored;
  }

  /** Removes the asks read, and only those. */
  async remove(id: string, stored: readonly StoredWakeAsk[]): Promise<void> {
    for (const { name } of stored) {
      await this.files.remove(join(asksFolderOf(this.folder, id), name));
    }
  }
}

/** The stored asks as a check finds them at one time. */
export interface AsksNow {
  /** The asks that wake the session: plain ones, and timed ones due whose line it has not seen; oldest first. */
  readonly asks: readonly WakeAsk[];
  /** The files a check that takes those asks removes: theirs, and the spent ones. */
  readonly taken: readonly StoredWakeAsk[];
  /** The files the next check removes whatever it does: damaged asks, and timed ones due whose line was seen first. */
  readonly spent: readonly StoredWakeAsk[];
  /** When the earliest timed ask not yet due comes due (it stays until then); undefined when none waits. */
  readonly nextAt: number | undefined;
}

/**
 * Sorts the stored asks at `now`. A timed ask is absent until its time, then present only while its line is among the
 * session's unseen lines: `unseen` hands their hashes (lines neither read nor shown at a prompt), and is called only
 * once a timed ask is due, since it reads the inbox.
 */
export async function asksNowOf(stored: readonly StoredWakeAsk[], now: number, unseen: () => Promise<ReadonlySet<string>>): Promise<AsksNow> {
  const asks: WakeAsk[] = [];
  const taken: StoredWakeAsk[] = [];
  const spent: StoredWakeAsk[] = [];
  const waiting: number[] = [];
  let unseenLines: ReadonlySet<string> | undefined;
  for (const each of stored) {
    const { ask } = each;
    if (ask === undefined) {
      spent.push(each);
    } else if (ask.by === undefined) {
      asks.push(ask);
      taken.push(each);
    } else if (now < ask.by.at) {
      waiting.push(ask.by.at);
    } else {
      unseenLines ??= await unseen();
      if (unseenLines.has(ask.by.line)) {
        asks.push(ask);
        taken.push(each);
      } else {
        spent.push(each);
      }
    }
  }
  return { asks, taken: [...taken, ...spent], spent, nextAt: waiting.length === 0 ? undefined : Math.min(...waiting) };
}

/** `an urgent line from <sender>`, or `<n> urgent lines from <senders>`, each sender once. */
export function urgentLinesText(asks: readonly WakeAsk[]): string {
  const senders = [...new Set(asks.map((ask) => ask.from))].join(', ');
  return `${asks.length === 1 ? 'an urgent line' : `${asks.length} urgent lines`} from ${senders}`;
}

/** Whether the asks wake the session now, at a later time, or not (none, or only damaged ones). */
export type AskVerdict = { readonly kind: 'none' } | { readonly kind: 'later'; readonly at: number } | { readonly kind: 'wake'; readonly asks: readonly WakeAsk[] };

/**
 * The asks found wake the session once the oldest plain one is `batchMs` old (`wake.batchSeconds`), so the asks posted
 * together (the closes one idle pass starts at once) wake it once, and at once for a timed ask due, its time being the
 * sender's; the minimum gap between wakes does not hold them, since each is urgent by its sender's choice. A timed
 * ask not yet due sets when to look again.
 */
export function askVerdictOf(found: AsksNow, now: number, batchMs: number): AskVerdict {
  const { asks, nextAt } = found;
  if (asks.length === 0) {
    return nextAt === undefined ? { kind: 'none' } : { kind: 'later', at: nextAt };
  }
  const at = Math.min(...asks.map((ask) => ask.by?.at ?? ask.at + batchMs));
  return now < at ? { kind: 'later', at: Math.min(at, nextAt ?? at) } : { kind: 'wake', asks };
}

/** `- HH:MM <sender>: <text>`, one line each, on the team's clock. */
function quotedLines(asks: readonly WakeAsk[], zone: TimeZone): string {
  return asks.map((ask) => `- ${zone.clock(new Date(ask.at))} ${ask.from}: ${ask.text}`).join('\n');
}

/** The wake's prompt: the asks quoted one a line, on the team's clock, then the work handed meanwhile, if any. */
export function handedPrompt(session: string, tasks: readonly Task[], asks: readonly WakeAsk[], cost: WakeCost, zone: TimeZone): string {
  if (asks.length === 0) {
    return wakePrompt(session, tasks, cost);
  }
  const rest = tasks.length === 0 ? `This wake costs ${costText(cost)}.` : wakePrompt(session, tasks, cost);
  return `Urgent lines were posted for you while this tab was idle; act on each now:\n${quotedLines(asks, zone)}\n${rest}`;
}

/**
 * The first prompt of a session reopened with urgent lines posted while it was closed (T1100): the lines quoted on
 * the team's clock ahead of its own first prompt (`prompt`), so it acts on them first; when that is over `max`
 * characters, their count and senders instead, since each is also an inbox line.
 */
export function urgentFirstPrompt(asks: readonly WakeAsk[], prompt: string, zone: TimeZone, max: number): string {
  if (asks.length === 0) {
    return prompt;
  }
  const quoted = `Urgent lines were posted for you while you were closed; act on each first:\n${quotedLines(asks, zone)}\n${prompt}`;
  return quoted.length <= max ? quoted : `Posted for you while you were closed, in your inbox: ${urgentLinesText(asks)}; act on each first.\n${prompt}`;
}

/** The person's toast: which lines and tasks woke the tab and what it costs. */
export function handedToast(tasks: readonly Task[], asks: readonly WakeAsk[], cost: WakeCost): string {
  if (asks.length === 0) {
    return wakeToast(tasks, cost);
  }
  const lines = urgentLinesText(asks);
  // The tasks first, so the senders' list ends the sentence and no id reads as a sender.
  const what = tasks.length === 0 ? lines : `${idsText(tasks)} and ${lines}`;
  return `${KIT_NAME} woke this tab for ${what} (${costText(cost)})`;
}
