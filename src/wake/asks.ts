import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { numberField, stringField } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { costText, idsText, wakePrompt, wakeToast, type WakeCost } from './decide.ts';

/**
 * A line that wakes the session it is for at its tab's next wake check, as work handed to it does: who posted it,
 * what it says (the wake's prompt quotes it) and when, epoch ms. It is posted beside the plain inbox line, which stays
 * the record; the ask only makes that line wake its receiver.
 */
export interface WakeAsk {
  readonly from: string;
  readonly text: string;
  readonly at: number;
}

/** The format of an ask's file; one in another format, or damaged, reads as no ask and goes at the next check. */
export const WAKE_ASK_FORMAT = 1;

export function formatWakeAsk(ask: WakeAsk): string {
  return toJsonlLine({ [VERSION_FIELD]: WAKE_ASK_FORMAT, from: ask.from, text: ask.text, at: ask.at });
}

/** An ask file's content; undefined when it is damaged or from another format. */
export function parseWakeAsk(text: string): WakeAsk | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== WAKE_ASK_FORMAT) {
    return undefined;
  }
  const from = stringField(record, 'from');
  const line = stringField(record, 'text');
  const at = numberField(record, 'at');
  return from === undefined || line === undefined || at === undefined ? undefined : { from, text: line, at };
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
      if (await this.files.createExclusive(join(this.folder, id, `${ask.at}-${n}.json`), text)) {
        return;
      }
    }
    throw new Error(`${id} already has ${ASKS_PER_MS} asks posted at ${new Date(ask.at).toISOString()}`);
  }

  /** The session's asks, oldest first. */
  async read(id: string): Promise<readonly StoredWakeAsk[]> {
    const named = (await this.files.list(join(this.folder, id))).flatMap((name) => {
      const order = orderOf(name);
      return order === undefined ? [] : [{ name, order }];
    });
    named.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    const stored: StoredWakeAsk[] = [];
    for (const { name } of named) {
      const text = await this.files.read(join(this.folder, id, name));
      if (text !== undefined) {
        stored.push({ name, ask: parseWakeAsk(text) });
      }
    }
    return stored;
  }

  /** Removes the asks read, and only those. */
  async remove(id: string, stored: readonly StoredWakeAsk[]): Promise<void> {
    for (const { name } of stored) {
      await this.files.remove(join(this.folder, id, name));
    }
  }
}

/** The asks read, without the damaged ones and those from another format. */
export function validAsksOf(stored: readonly StoredWakeAsk[]): readonly WakeAsk[] {
  return stored.flatMap((each) => (each.ask === undefined ? [] : [each.ask]));
}

/** `an urgent line from <sender>`, or `<n> urgent lines from <senders>`, each sender once. */
export function urgentLinesText(asks: readonly WakeAsk[]): string {
  const senders = [...new Set(asks.map((ask) => ask.from))].join(', ');
  return `${asks.length === 1 ? 'an urgent line' : `${asks.length} urgent lines`} from ${senders}`;
}

/** Whether the asks wake the session now, at a later time, or not (none, or only damaged ones). */
export type AskVerdict = { readonly kind: 'none' } | { readonly kind: 'later'; readonly at: number } | { readonly kind: 'wake'; readonly asks: readonly WakeAsk[] };

/**
 * The asks wake the session once the oldest is `batchMs` old (`wake.batchSeconds`), so the asks posted together (the
 * closes one idle pass starts at once) wake it once; the minimum gap between wakes does not hold them, since each is
 * urgent by its sender's choice.
 */
export function askVerdictOf(stored: readonly StoredWakeAsk[], now: number, batchMs: number): AskVerdict {
  const asks = validAsksOf(stored);
  if (asks.length === 0) {
    return { kind: 'none' };
  }
  const at = Math.min(...asks.map((ask) => ask.at)) + batchMs;
  return now < at ? { kind: 'later', at } : { kind: 'wake', asks };
}

/** The wake's prompt: the asks quoted one a line, on the team's clock, then the work handed meanwhile, if any. */
export function handedPrompt(session: string, tasks: readonly Task[], asks: readonly WakeAsk[], cost: WakeCost, zone: TimeZone): string {
  if (asks.length === 0) {
    return wakePrompt(session, tasks, cost);
  }
  const lines = asks.map((ask) => `- ${zone.clock(new Date(ask.at))} ${ask.from}: ${ask.text}`);
  const rest = tasks.length === 0 ? `This wake costs ${costText(cost)}.` : wakePrompt(session, tasks, cost);
  return `Urgent lines were posted for you while this tab was idle; act on each now:\n${lines.join('\n')}\n${rest}`;
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
