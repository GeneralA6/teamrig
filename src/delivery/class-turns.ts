import { instantField, isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import type { ClassTurns } from './admission.ts';

/**
 * Class turns in the host lock's line (T2210, stride scheduling): each work class keeps a virtual time, and among the
 * classes with a step waiting the least goes next. A step is charged its expected minutes when it is admitted, so the
 * next admission already counts it, and its end corrects the charge to the minutes it ran. The state is the file
 * `<lock>.turns.json`, which only admission writes, under the admit file.
 */

/** The turns file's format (CONTRIBUTING, Stored files): a field added at any depth raises it. */
export const TURNS_FORMAT = 1;

/** The minutes charged at admission to a step whose need learned no run time, until its end says what it ran. */
export const DEFAULT_EXPECTED_MINUTES = 5;

/** A step admitted and charged to its class, kept open until its end is read: its ticket's id, class and the class's allocation percent, when it was admitted (ISO) and the minutes charged. */
export interface OpenCharge {
  readonly ticket: string;
  readonly class: string;
  readonly pct: number;
  readonly at: string;
  readonly minutes: number;
}

/** The class turns: each class's virtual time, the floor an idle class is lifted to, and the charges still open. */
export interface TurnsState {
  readonly floor: number;
  readonly classes: ReadonlyMap<string, number>;
  readonly open: readonly OpenCharge[];
}

/** No turns yet: every class at 0. A missing or damaged turns file reads as this, a moment of arrival order across classes, never a stuck line. */
export const EMPTY_TURNS: TurnsState = { floor: 0, classes: new Map(), open: [] };

const MINUTE_MS = 60_000;

/** The virtual time `minutes` of run add to a class allocated `pct`: minutes * 100 / pct, a 0% class counting as 1%, so it still runs when no other class waits. */
export function virtualMinutes(minutes: number, pct: number): number {
  return (minutes * 100) / Math.max(pct, 1);
}

function isTurn(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function chargeOf(value: unknown): OpenCharge | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const [ticket, workClass, at] = [stringField(value, 'ticket'), stringField(value, 'class'), stringField(value, 'at')];
  const [pct, minutes] = [value['pct'], value['minutes']];
  if (ticket === undefined || workClass === undefined || at === undefined || instantField(value, 'at') === undefined || !isTurn(pct) || !isTurn(minutes)) {
    return undefined;
  }
  return { ticket, class: workClass, pct, at, minutes };
}

function turnsOf(value: unknown): TurnsState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const [floor, kept, opened] = [value['floor'], value['classes'], value['open']];
  if (!isTurn(floor) || !isRecord(kept) || !Array.isArray(opened)) {
    return undefined;
  }
  const entries = Object.entries(kept);
  const classes = entries.flatMap(([name, turn]) => (isTurn(turn) ? [[name, turn] as const] : []));
  const open = opened.flatMap((item: unknown) => {
    const charge = chargeOf(item);
    return charge === undefined ? [] : [charge];
  });
  return classes.length === entries.length && open.length === opened.length ? { floor, classes: new Map(classes), open } : undefined;
}

/** The turns file's record and its format; undefined for a missing or damaged file, or a format that is no number. */
function recordOf(text: string | undefined): { readonly record: JsonRecord; readonly format: number } | undefined {
  const record = text === undefined ? undefined : parseObject(text);
  const format = record === undefined ? undefined : recordVersion(record);
  return record === undefined || format === undefined ? undefined : { record, format };
}

/**
 * Whether a newer teamrig wrote the turns `text`. This one then reads no turns from it and must not rewrite it, which
 * would drop the fields it does not know: an older teamrig left running in some tab while the rest upgraded.
 */
export function isNewerTurns(text: string | undefined): boolean {
  const read = recordOf(text);
  return read !== undefined && read.format > TURNS_FORMAT;
}

/** The turns `text` keeps; a missing or damaged file, or one in a newer format, is {@link EMPTY_TURNS}. */
export function parseTurns(text: string | undefined): TurnsState {
  const read = recordOf(text);
  return read === undefined || read.format > TURNS_FORMAT ? EMPTY_TURNS : (turnsOf(read.record) ?? EMPTY_TURNS);
}

/** The turns file's text for `state`, in {@link TURNS_FORMAT}. */
export function turnsText(state: TurnsState): string {
  return JSON.stringify({ [VERSION_FIELD]: TURNS_FORMAT, floor: state.floor, classes: Object.fromEntries(state.classes), open: state.open });
}

/** The text of an ended marker (`<lock>.ended/<id>.json`): a step's release writes it, so admission can correct its charge. */
export function endedText(endedAt: string): string {
  return JSON.stringify({ endedAt });
}

/** The end (ms) an ended marker's `text` keeps; undefined for a missing or damaged one. */
export function endedAtOf(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? instantField(value, 'endedAt') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The turns once the steps' ends are read: an open charge whose step ended (`ended`: its ticket's id to its end, ms) is
 * corrected to the minutes it ran from its admission and closed; one whose step neither ended nor runs (`running`: the
 * ids of the lock and its shares) died before writing its end, so its estimate stands and it is closed; the rest stay
 * open.
 */
export function settle(state: TurnsState, ended: ReadonlyMap<string, number>, running: ReadonlySet<string>): TurnsState {
  const classes = new Map(state.classes);
  const open = state.open.filter((charge) => {
    const endedAt = ended.get(charge.ticket);
    if (endedAt === undefined) {
      return running.has(charge.ticket);
    }
    const ran = Math.max(0, endedAt - Date.parse(charge.at)) / MINUTE_MS;
    const turn = (classes.get(charge.class) ?? state.floor) + virtualMinutes(ran - charge.minutes, charge.pct);
    // Rounding over several charges may leave a hair under 0, which the file's reader would refuse.
    classes.set(charge.class, Math.max(0, turn));
    return false;
  });
  return { floor: state.floor, classes, open };
}

/** The turn of each class in `waiting` (the classes with a step in line): its virtual time, else the floor. */
export function turnsFor(state: TurnsState, waiting: Iterable<string>): ClassTurns {
  return new Map([...waiting].map((name) => [name, state.classes.get(name) ?? state.floor]));
}

/**
 * The turns once `step` is admitted, with the classes `waiting` in line (its own counts too): the floor rises to the
 * least turn among them; each class with neither a step waiting nor an open charge is lifted to the floor, so a class
 * idle while others ran banks no turns; the step's class is charged its minutes and the charge kept open. A class with
 * a step still running is not lifted, as its charge's correction at the end would count the lifted minutes twice: a
 * 60-minute step beside twelve 5-minute steps of another class at 50/50 would end 220 to 120, not even.
 */
export function charge(state: TurnsState, step: OpenCharge, waiting: Iterable<string>): TurnsState {
  const inPlay = new Set([...waiting, step.class]);
  const least = Math.min(...[...inPlay].map((name) => state.classes.get(name) ?? state.floor));
  const floor = Math.max(state.floor, least);
  const running = new Set(state.open.map((open) => open.class));
  const classes = new Map([...state.classes].map(([name, turn]) => [name, inPlay.has(name) || running.has(name) ? turn : Math.max(turn, floor)]));
  classes.set(step.class, (state.classes.get(step.class) ?? floor) + virtualMinutes(step.minutes, step.pct));
  return { floor, classes, open: [...state.open, step] };
}
