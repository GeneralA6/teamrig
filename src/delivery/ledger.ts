import type { Files } from '../core/files.ts';
import { isStringArray, stringField, type JsonRecord } from '../core/guards.ts';
import { parseJsonl } from '../core/jsonl.ts';
import { formatUtcMinute } from '../core/time.ts';

/** The ledger's file name in the delivery folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';

/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';

/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: deployed at (UTC) | session | repo | range | what | kind | note';

/**
 * A queued step in the ledger, stored under its old type name `heavy`, in the format a team's own deploy tool writes
 * too: once when it starts (`endedAt` and `exitCode` null), and again with both when it ends, under the same `id`.
 * The optional fields are teamrig's own; a record without them is still read.
 */
export interface QueuedStepRecord {
  readonly type: 'heavy';
  readonly id: string;
  readonly session: string;
  readonly what: string;
  /** The teamrig version that ran the step; an older teamrig or a team's own deploy tool leaves it out. */
  readonly kit?: string;
  /** An ISO time: when the step began to wait for the host lock, so its wait is `startedAt` less this. */
  readonly queuedAt?: string;
  /** Set when the step was a small one sharing the host (`queue --small`), not holding the host lock. */
  readonly shared?: true;
  /** An ISO time: when it took the host lock and started. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** On the end record: the most the step's process tree held at once, in MB. */
  readonly peakTreeMb?: number;
  /** On the end record: the least free memory the host had while the step ran, in MB. */
  readonly lowFreeMb?: number;
  /** On the end record: the host's free memory when the step started, in MB; less `lowFreeMb`, what the host lost while it ran. */
  readonly startFreeMb?: number;
  /** On the end record of a killed step (exit 124 or 129): the host's free memory when it was killed, in MB. */
  readonly endFreeMb?: number;
  /** On the end record of a killed step, where the host reads it: its commit charge then, in MB. */
  readonly commitMb?: number;
  /** With `commitMb`: the most the host can commit (RAM plus page files), in MB. */
  readonly commitLimitMb?: number;
}

/** The memory fields a queued step's end record may carry, each a whole number of MB. */
const STEP_MEMORY_FIELDS = ['peakTreeMb', 'lowFreeMb', 'startFreeMb', 'endFreeMb', 'commitMb', 'commitLimitMb'] as const;

type StepMemoryField = (typeof STEP_MEMORY_FIELDS)[number];

/**
 * A deploy in the ledger, in the format a team's own deploy tool writes too. `range` is the commits it landed,
 * `<first>..<last>` by 8-character sha; `rolledAt` is when it went live, for a host that deploys on push when the push
 * ended.
 */
export interface DeployRecord {
  readonly type: 'deploy';
  /** `rollback` is written by a team's own deploy tool only, so far. */
  readonly kind: 'deploy' | 'rollback';
  readonly session: string;
  readonly repo: string;
  readonly range: string;
  readonly what: string;
  readonly note: string;
  /** An ISO time. */
  readonly startedAt: string;
  /** An ISO time. */
  readonly rolledAt: string;
  /** The targets a deploy of only some of its repository's targets restarted (`teamrig deploy --targets`); unset, all of them. */
  readonly targets?: readonly string[];
}

/**
 * A background job a session declared (`teamrig job`), stored under its old name as a `load` record, in the format a
 * team's own deploy tool writes too: once when it starts (`endedAt` null), and again when it ends, under the same `id`.
 */
export interface JobRecord {
  readonly type: 'load';
  readonly id: string;
  readonly session: string;
  readonly what: string;
  /** The deploy targets it runs on, or `host` for every one. */
  readonly targets: readonly string[] | 'host';
  /** An ISO time. */
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export type LedgerRecord = QueuedStepRecord | DeployRecord | JobRecord;

/** A deploy as its ledger.md line names it; a session may write one by hand. */
export interface LedgerMdDeploy {
  /** When it went live, in ms, to the minute. */
  readonly rolledAt: number;
  readonly session: string;
  readonly repo: string;
  readonly kind: 'deploy' | 'rollback';
}

/** The two ledger files a deploy is written to. */
export interface LedgerPlaces {
  readonly ledger: string;
  readonly ledgerMd: string;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The landed commits as the ledger names them: `<first>..<last>` by 8-character sha, or the one commit. */
export function rangeText(commits: readonly string[], fallback: string): string {
  const first = commits[0];
  const last = commits[commits.length - 1];
  if (first === undefined || last === undefined) {
    return short(fallback);
  }
  return first === last ? short(first) : `${short(first)}..${short(last)}`;
}

/** Appends one record as one line, in one write. */
export async function appendRecord(files: Pick<Files, 'append'>, ledger: string, record: LedgerRecord): Promise<void> {
  await files.append(ledger, `${JSON.stringify(record)}\n`);
}

/** A deploy's ledger.md line, `- <deployed at> | session | repo | range | what | kind | note`; a `|` or line break in a field becomes `/`. */
export function ledgerLine(record: DeployRecord): string {
  const fields = [record.session, record.repo, record.range, record.what, record.kind, record.note].map((field) => field.replace(/[|\r\n]/g, '/'));
  return `- ${formatUtcMinute(new Date(record.rolledAt))} | ${fields.join(' | ')}`;
}

/** Appends a deploy to the JSON ledger and its line to ledger.md, starting a missing ledger.md with its header. */
export async function appendDeploy(files: Files, places: LedgerPlaces, record: DeployRecord): Promise<void> {
  await appendRecord(files, places.ledger, record);
  await files.createExclusive(places.ledgerMd, `${LEDGER_MD_HEADER}\n`);
  await files.append(places.ledgerMd, `${ledgerLine(record)}\n`);
}

/** An ISO time field; undefined when it is missing or no time. */
function timeField(record: JsonRecord, key: string): string | undefined {
  const value = stringField(record, key);
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** A whole number of MB; undefined when it is missing or anything else. */
function mbField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The optional fields a record carries, each left out when it is missing or bad, since they only add to it. */
function queuedStepExtrasOf(record: JsonRecord): Pick<QueuedStepRecord, 'kit' | 'queuedAt' | 'shared' | StepMemoryField> {
  const [kit, queuedAt] = [stringField(record, 'kit'), timeField(record, 'queuedAt')];
  const memory: Partial<Record<StepMemoryField, number>> = {};
  for (const field of STEP_MEMORY_FIELDS) {
    const mb = mbField(record, field);
    if (mb !== undefined) {
      memory[field] = mb;
    }
  }
  return {
    ...(kit === undefined ? {} : { kit }),
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(record['shared'] === true ? { shared: true } : {}),
    ...memory,
  };
}

/** An end that may not have come yet: null, else an ISO time; undefined when it is neither. */
function endField(record: JsonRecord, key: string): string | null | undefined {
  return record[key] === null ? null : timeField(record, key);
}

function queuedStepOf(record: JsonRecord): QueuedStepRecord | undefined {
  const [id, session, what] = [stringField(record, 'id'), stringField(record, 'session'), stringField(record, 'what')];
  const [startedAt, endedAt] = [timeField(record, 'startedAt'), endField(record, 'endedAt')];
  const exitCode = record['exitCode'];
  const exit = exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)) ? exitCode : undefined;
  if (id === undefined || session === undefined || what === undefined || startedAt === undefined || endedAt === undefined || exit === undefined) {
    return undefined;
  }
  return { type: 'heavy', id, session, what, startedAt, endedAt, exitCode: exit, ...queuedStepExtrasOf(record) };
}

function deployOf(record: JsonRecord): DeployRecord | undefined {
  const kind = record['kind'];
  const [session, repo, range] = [stringField(record, 'session'), stringField(record, 'repo'), stringField(record, 'range')];
  const [what, note] = [stringField(record, 'what'), stringField(record, 'note')];
  const [startedAt, rolledAt] = [timeField(record, 'startedAt'), timeField(record, 'rolledAt')];
  const targets = record['targets'];
  if ((kind !== 'deploy' && kind !== 'rollback') || session === undefined || repo === undefined || range === undefined || what === undefined || note === undefined || startedAt === undefined || rolledAt === undefined) {
    return undefined;
  }
  return { type: 'deploy', kind, session, repo, range, what, note, startedAt, rolledAt, ...(isStringArray(targets) ? { targets } : {}) };
}

function jobOf(record: JsonRecord): JobRecord | undefined {
  const [id, session, what] = [stringField(record, 'id'), stringField(record, 'session'), stringField(record, 'what')];
  const [startedAt, endedAt] = [timeField(record, 'startedAt'), endField(record, 'endedAt')];
  const targets = record['targets'];
  const jobTargets = targets === 'host' || isStringArray(targets) ? targets : undefined;
  if (id === undefined || session === undefined || what === undefined || startedAt === undefined || endedAt === undefined || jobTargets === undefined) {
    return undefined;
  }
  return { type: 'load', id, session, what, targets: jobTargets, startedAt, endedAt };
}

const READERS: Readonly<Record<LedgerRecord['type'], (record: JsonRecord) => LedgerRecord | undefined>> = { heavy: queuedStepOf, deploy: deployOf, load: jobOf };

function isLedgerType(type: unknown): type is LedgerRecord['type'] {
  return type === 'heavy' || type === 'deploy' || type === 'load';
}

/** The ledger's queued step, deploy and job records, in file order; a damaged line, a record of another type or one with a bad field is left out. */
export function parseLedger(text: string): LedgerRecord[] {
  return parseJsonl(text).records.flatMap(({ record }) => {
    const type = record['type'];
    const read = isLedgerType(type) ? READERS[type](record) : undefined;
    return read === undefined ? [] : [read];
  });
}

const MD_MINUTE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** A ledger.md minute, `YYYY-MM-DD HH:MM` UTC, in ms; undefined for anything else. */
function mdMinute(text: string): number | undefined {
  const parts = MD_MINUTE.exec(text);
  if (parts === null) {
    return undefined;
  }
  const time = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00Z`);
  return Number.isFinite(time) ? time : undefined;
}

/** The deploys and rollbacks of ledger.md, in file order; the header, other kinds (`start`) and malformed lines are left out. */
export function parseLedgerMd(text: string): LedgerMdDeploy[] {
  return text.split('\n').flatMap((line): LedgerMdDeploy[] => {
    if (!line.startsWith('- ')) {
      return [];
    }
    const [when = '', session = '', repo = '', , , kind = ''] = line.slice(2).split('|').map((cell) => cell.trim());
    const rolledAt = mdMinute(when);
    if (rolledAt === undefined || session === '' || repo === '' || (kind !== 'deploy' && kind !== 'rollback')) {
      return [];
    }
    return [{ rolledAt, session, repo, kind }];
  });
}
