import { basename, dirname, join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';
import { ownerTurnsOf, type OwnerTurn } from './owner-turns.ts';
import { REFRESH_FORMAT } from './state.ts';

/**
 * How much of the old transcript is read: enough to reach back past its last compaction, whose cron
 * snapshot the jobs are counted from. A job made before that and never compacted since is missed.
 */
export const CARRY_TAIL_BYTES = 64 * 1024 * 1024;
/** Claude Code ends a recurring session job 7 days after it was made. */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** ScheduleWakeup's shortest delay. */
const WAKE_MIN_SECONDS = 60;

/** A scheduled job (CronCreate) still live when the session ended: it lives in the process, so a /clear keeps it and a new process loses it. */
export interface CarriedCron {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
  /** When it was made, in ms; a recurring job ends 7 days after. */
  readonly createdAt: number;
}

/** A wake-up (ScheduleWakeup) still to come when the session ended. */
export interface CarriedWake {
  /** When it is due, in ms. */
  readonly dueAt: number;
  readonly prompt: string;
}

/** What the old transcript shows the session still had scheduled, and the slug its plan file is named by. */
export interface TranscriptCarry {
  readonly crons: readonly CarriedCron[];
  readonly wake: CarriedWake | undefined;
  readonly planSlug: string | undefined;
}

/**
 * The jobs a /clear left live in the process of the fresh session whose transcript is `transcript`: its transcript
 * never names them, so the next carry starts from them (T657).
 */
export interface CarriedJobs {
  readonly transcript: string;
  readonly crons: readonly CarriedCron[];
}

/** What a fresh session should take over from the one it replaced. */
export interface Carry extends TranscriptCarry {
  /** The old session's scratchpad folder and how many entries it holds; undefined when it is gone or empty. */
  readonly scratchpad: { readonly path: string; readonly entries: number } | undefined;
  /** The old session's plan file; undefined when it has none. */
  readonly plan: string | undefined;
  /** What the owner typed in the old session (`owner-turns.ts`); absent when the handover path was not given. */
  readonly ownerTurns?: readonly OwnerTurn[];
}

/** Where Claude Code keeps a session's files outside its transcript. */
export interface CarryPlaces {
  /** The system's temporary folder: a scratchpad the transcript does not name is `<it>/claude/<project>/<session>/scratchpad`. */
  readonly tempDir: string;
  /** Claude Code's config folder: plans are `<it>/plans/<slug>.md`. */
  readonly claudeDir: string;
}

/** Lines that can matter; the rest of a large transcript is never parsed. */
const MARKERS: readonly string[] = ['session_cron_carry', '"CronCreate"', '"CronDelete"', '"ScheduleWakeup"', '"humanSchedule"', '"scheduledFor"', '"is_error":true', '"queue-operation"'];
const SLUG_KEY = '"slug":"';
const ENVIRONMENT_KEY = '"type":"environment"';
const SLUG = /^[A-Za-z0-9_-]+$/;

/** A pending CronCreate call: what it asked for, until its result names the job. */
interface CronAsk {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly at: number;
}

function blocksOf(entry: JsonRecord): readonly JsonRecord[] {
  const message = entry['message'];
  const content = isRecord(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** The jobs of a compaction's `session_cron_carry` snapshot, or of a carried-jobs file. */
function snapshotOf(tasks: unknown): Map<string, CarriedCron> {
  const crons = new Map<string, CarriedCron>();
  for (const task of Array.isArray(tasks) ? tasks.filter(isRecord) : []) {
    const id = stringField(task, 'id');
    const cron = stringField(task, 'cron');
    const prompt = stringField(task, 'prompt');
    const createdAt = task['createdAt'];
    if (id !== undefined && cron !== undefined && prompt !== undefined && typeof createdAt === 'number') {
      crons.set(id, { id, cron, prompt, recurring: task['recurring'] !== false, createdAt });
    }
  }
  return crons;
}

/**
 * The jobs live in the process when Claude Code wrote a `session_cron_carry` snapshot: the session's own (`tasks`)
 * and those an earlier session in the process armed (`otherArmed`, Claude Code 2.1.310), which CronList lists too.
 */
function cronSnapshotOf(attachment: JsonRecord): Map<string, CarriedCron> {
  return new Map([...snapshotOf(attachment['tasks']), ...snapshotOf(attachment['otherArmed'])]);
}

/** The session's slug, from the last entry that names one: its plan file is named by it. */
function lastSlugOf(text: string): string | undefined {
  const start = text.lastIndexOf(SLUG_KEY);
  if (start < 0) {
    return undefined;
  }
  const from = start + SLUG_KEY.length;
  const slug = text.slice(from, text.indexOf('"', from));
  return SLUG.test(slug) ? slug : undefined;
}

/** Follows a transcript's scheduling calls in order, from its last cron snapshot on. */
class ScheduleFold {
  crons: Map<string, CarriedCron>;
  wake: CarriedWake | undefined;
  private wakeCall: string | undefined;
  private readonly asks = new Map<string, CronAsk>();

  constructor(inherited: readonly CarriedCron[]) {
    this.crons = new Map(inherited.map((cron) => [cron.id, cron]));
  }

  entry(entry: JsonRecord): void {
    const attachment = entry['attachment'];
    if (isRecord(attachment) && attachment['type'] === 'session_cron_carry') {
      this.crons = cronSnapshotOf(attachment);
      return;
    }
    if (entry['type'] === 'queue-operation' && entry['operation'] === 'enqueue') {
      this.fired(stringField(entry, 'content'));
      return;
    }
    const at = Date.parse(stringField(entry, 'timestamp') ?? '');
    for (const block of blocksOf(entry)) {
      if (block['type'] === 'tool_use') {
        this.call(block, at);
      } else if (block['type'] === 'tool_result') {
        this.result(block, entry['toolUseResult']);
      }
    }
  }

  /** A prompt Claude Code queued: a one-shot job or the wake-up with that prompt has fired. */
  private fired(content: string | undefined): void {
    if (content === undefined) {
      return;
    }
    for (const cron of [...this.crons.values()]) {
      if (!cron.recurring && cron.prompt === content) {
        this.crons.delete(cron.id);
      }
    }
    if (this.wake?.prompt === content) {
      this.wake = undefined;
    }
  }

  private call(block: JsonRecord, at: number): void {
    const id = stringField(block, 'id');
    const input = block['input'];
    if (id === undefined || !isRecord(input)) {
      return;
    }
    switch (stringField(block, 'name')) {
      case 'CronCreate': {
        const cron = stringField(input, 'cron');
        const prompt = stringField(input, 'prompt');
        if (cron !== undefined && prompt !== undefined && Number.isFinite(at)) {
          this.asks.set(id, { cron, prompt, recurring: input['recurring'] !== false, at });
        }
        return;
      }
      case 'CronDelete': {
        const job = stringField(input, 'id');
        if (job !== undefined) {
          this.crons.delete(job);
        }
        return;
      }
      case 'ScheduleWakeup': {
        const prompt = stringField(input, 'prompt');
        const delay = input['delaySeconds'];
        const scheduled = input['stop'] !== true && prompt !== undefined && typeof delay === 'number' && Number.isFinite(at);
        this.wake = scheduled ? { dueAt: at + delay * 1000, prompt } : undefined;
        this.wakeCall = scheduled ? id : undefined;
        return;
      }
      default:
        return;
    }
  }

  private result(block: JsonRecord, result: unknown): void {
    const useId = stringField(block, 'tool_use_id');
    if (useId === undefined) {
      return;
    }
    const ask = this.asks.get(useId);
    this.asks.delete(useId);
    const failed = block['is_error'] === true || !isRecord(result);
    if (useId === this.wakeCall) {
      // Claude Code clamps the delay; its result says when the wake-up is really due.
      const scheduledFor = isRecord(result) ? result['scheduledFor'] : undefined;
      if (failed) {
        this.wake = undefined;
      } else if (this.wake !== undefined && typeof scheduledFor === 'number') {
        this.wake = { ...this.wake, dueAt: scheduledFor };
      }
    }
    const job = isRecord(result) ? stringField(result, 'id') : undefined;
    if (ask === undefined || failed || job === undefined) {
      return;
    }
    const recurring = isRecord(result) && typeof result['recurring'] === 'boolean' ? result['recurring'] : ask.recurring;
    this.crons.set(job, { id: job, cron: ask.cron, prompt: ask.prompt, recurring, createdAt: ask.at });
  }
}

/**
 * What a transcript shows its session still had scheduled at `now`: the jobs it `inherited` (those a /clear left
 * live in its process) or, from its last compaction on, that compaction's snapshot, and the CronCreate calls after
 * them, less those deleted, fired once or past their 7 days, and the last wake-up asked for, if it is still to come.
 */
export function carryOf(text: string, now: number, inherited: readonly CarriedCron[]): TranscriptCarry {
  const fold = new ScheduleFold(inherited);
  for (const line of text.split('\n')) {
    if (!MARKERS.some((marker) => line.includes(marker))) {
      continue;
    }
    const entry = parseObject(line.trim());
    if (entry !== undefined) {
      fold.entry(entry);
    }
  }
  const crons = [...fold.crons.values()].filter((cron) => !cron.recurring || now - cron.createdAt < RECURRING_MAX_AGE_MS);
  const wake = fold.wake !== undefined && fold.wake.dueAt > now ? fold.wake : undefined;
  return { crons, wake, planSlug: lastSlugOf(text) };
}

/**
 * The scratchpad Claude Code last gave the session, from its last `environment` attachment. It can sit under
 * another project folder than the transcript: a session that moved into a worktree keeps its transcript in
 * the new project folder and its scratchpad where it was. A quoted copy in a tool result is JSON-escaped, so
 * only a real attachment matches the key.
 */
export function toldScratchpadOf(text: string): string | undefined {
  let end = text.length;
  while (end > 0) {
    const at = text.lastIndexOf(ENVIRONMENT_KEY, end - 1);
    if (at < 0) {
      return undefined;
    }
    const start = text.lastIndexOf('\n', at) + 1;
    const stop = text.indexOf('\n', at);
    const attachment = parseObject(text.slice(start, stop < 0 ? text.length : stop).trim())?.['attachment'];
    const snapshot = isRecord(attachment) && attachment['type'] === 'environment' ? attachment['snapshot'] : undefined;
    const told = isRecord(snapshot) ? stringField(snapshot, 'scratchpadDirectory') : undefined;
    if (told !== undefined) {
      return told;
    }
    end = start;
  }
  return undefined;
}

/** The scratchpad folder a transcript's own name gives, `<temp>/claude/<project>/<session>/scratchpad`: the guess when its tail names none. */
export function scratchpadOf(transcript: string, tempDir: string): string {
  return join(tempDir, 'claude', basename(dirname(transcript)), basename(transcript, '.jsonl'), 'scratchpad');
}

/**
 * What the session whose transcript this is leaves for the fresh one, counting the jobs it `inherited`, and with
 * `handoverPath` what the owner typed in it; undefined when the transcript is gone.
 */
export async function readCarry(
  files: Files,
  transcript: string,
  now: number,
  places: CarryPlaces,
  inherited: readonly CarriedCron[],
  handoverPath?: string,
): Promise<Carry | undefined> {
  const text = await files.readTail(transcript, CARRY_TAIL_BYTES);
  if (text === undefined) {
    return undefined;
  }
  const found = carryOf(text, now, inherited);
  const scratchpad = toldScratchpadOf(text) ?? scratchpadOf(transcript, places.tempDir);
  const entries = (await files.list(scratchpad)).length;
  const plan = found.planSlug === undefined ? undefined : join(places.claudeDir, 'plans', `${found.planSlug}.md`);
  const planText = plan === undefined ? undefined : await files.read(plan);
  const owner = handoverPath === undefined ? {} : { ownerTurns: ownerTurnsOf(text, handoverPath, [...inherited.map((cron) => cron.prompt)]) };
  return { ...found, scratchpad: entries > 0 ? { path: scratchpad, entries } : undefined, plan: planText === undefined ? undefined : plan, ...owner };
}

/** A carried-jobs file's content; undefined when it is damaged or from another format. */
export function parseCarriedJobs(text: string): CarriedJobs | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== REFRESH_FORMAT || !Array.isArray(record['crons'])) {
    return undefined;
  }
  const transcript = stringField(record, 'transcript');
  return transcript === undefined ? undefined : { transcript, crons: [...snapshotOf(record['crons']).values()] };
}

export function formatCarriedJobs(jobs: CarriedJobs): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...jobs });
}

/** How the fresh session started: in the old session's process (a /clear) or in a new one. */
export type CarryStart = 'same-process' | 'new-process';

/** A /clear starts the fresh session in the process it cleared; every other fresh start is a new process. */
export function carryStartOf(source: string | undefined): CarryStart {
  return source === 'clear' ? 'same-process' : 'new-process';
}

/**
 * The lines that tell a fresh session what to take over: its jobs (still scheduled after a /clear, proven
 * on Claude Code 2.1.301 (T398), so made again only in a new process, and then only those CronList does not
 * show, as a durable job comes back by itself), the wake-up to schedule again (its time on the team's clock),
 * and where the old scratchpad and plan are. Empty when there is nothing. What the owner typed goes to its own file.
 */
export function carryLines(carry: Carry, now: number, start: CarryStart, zone: TimeZone): readonly string[] {
  const lines: string[] = [];
  if (carry.crons.length > 0 && start === 'same-process') {
    lines.push(`Your old session's ${carry.crons.length} scheduled job(s) are still scheduled, since a /clear keeps the process (CronList shows them): do not make them again.`);
  } else if (carry.crons.length > 0) {
    lines.push(`Your old session had ${carry.crons.length} scheduled job(s), which end with its process: run CronList and make each one it does not show again with CronCreate:`);
    for (const cron of carry.crons) {
      lines.push(`- cron ${JSON.stringify(cron.cron)}, recurring ${String(cron.recurring)}, prompt ${JSON.stringify(cron.prompt)}`);
    }
  }
  if (carry.wake !== undefined) {
    const seconds = Math.max(WAKE_MIN_SECONDS, Math.ceil((carry.wake.dueAt - now) / 1000));
    lines.push(`It had a wake-up due at ${zone.clock(new Date(carry.wake.dueAt))}: schedule it again with ScheduleWakeup, delaySeconds ${seconds}, prompt ${JSON.stringify(carry.wake.prompt)}.`);
  }
  if (carry.scratchpad !== undefined) {
    lines.push(`Its scratchpad stays at ${carry.scratchpad.path} (${carry.scratchpad.entries} entries); yours is a new, empty one, so read or copy from the old one what you still need.`);
  }
  if (carry.plan !== undefined) {
    lines.push(`Its plan file: ${carry.plan}.`);
  }
  return lines;
}
