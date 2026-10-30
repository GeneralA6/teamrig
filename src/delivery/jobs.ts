import type { Files } from '../core/files.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { TimeZone } from '../core/zone.ts';
import { appendRecord, parseLedger, type LedgerRecord, type JobRecord } from './ledger.ts';

/** A job's id is the start of a new id, unique among the ledger's jobs: short enough to type into `teamrig job end`. */
const ID_LENGTH = 8;

/** New ids tried before giving up; with random ids, one clash is already rare. */
const ID_TRIES = 10;

export interface JobPorts {
  readonly files: Pick<Files, 'read' | 'append'>;
  readonly newId: () => string;
}

export type JobOutcome = { readonly kind: 'done'; readonly record: JobRecord } | { readonly kind: 'refused'; readonly reason: string };

/** A job a session declares, from `startedAt` (ms). */
export interface JobStart {
  readonly session: string;
  readonly what: string;
  readonly targets: readonly string[] | 'host';
  readonly startedAt: number;
}

export interface JobRules {
  /** The targets the team's repositories deploy; `host` is always known. */
  readonly knownTargets: readonly string[];
  readonly scanner: SecretScanner;
  readonly nowMs: number;
  /** The team's zone, which a refusal prints its times in. */
  readonly zone: TimeZone;
}

/** A session ending its job `id` at `endedAt` (ms). */
export interface JobEnd {
  readonly session: string;
  readonly id: string;
  readonly endedAt: number;
  readonly nowMs: number;
  /** The team's zone, which a refusal prints its times in. */
  readonly zone: TimeZone;
}

/** An instant as the team reads it: `2030-01-08 12:00 IST`. */
function minuteText(ms: number, zone: TimeZone): string {
  return zone.minute(new Date(ms));
}

function isJob(record: LedgerRecord): record is JobRecord {
  return record.type === 'load';
}

function refused(reason: string): JobOutcome {
  return { kind: 'refused', reason };
}

function startRefusal(rules: JobRules, start: JobStart): string | undefined {
  if (start.startedAt > rules.nowMs) {
    return `a job cannot start in the future (${minuteText(start.startedAt, rules.zone)})`;
  }
  if (start.targets !== 'host') {
    const unknown = start.targets.filter((target) => !rules.knownTargets.includes(target));
    if (unknown.length > 0) {
      return `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a deploy target of this team (known: ${[...rules.knownTargets, 'host'].join(', ')})`;
    }
  }
  return rules.scanner.refusal('what the job is', start.what);
}

function freshId(ports: JobPorts, taken: ReadonlySet<string>): string {
  for (let tries = 0; tries < ID_TRIES; tries += 1) {
    const id = ports.newId().slice(0, ID_LENGTH);
    if (!taken.has(id)) {
      return id;
    }
  }
  throw new Error(`no free job id after ${ID_TRIES} tries`);
}

/**
 * Declares a background job from `start.startedAt` with a new id, written to the ledger. Refused for a start in the
 * future, a target no repository deploys, or a secret in what it is, since the ledger is shared.
 */
export async function startJob(ports: JobPorts, ledger: string, rules: JobRules, start: JobStart): Promise<JobOutcome> {
  const refusal = startRefusal(rules, start);
  if (refusal !== undefined) {
    return refused(refusal);
  }
  const taken = new Set(parseLedger((await ports.files.read(ledger)) ?? '').filter(isJob).map((job) => job.id));
  const record: JobRecord = {
    type: 'load',
    id: freshId(ports, taken),
    session: start.session,
    what: start.what,
    targets: start.targets,
    startedAt: new Date(start.startedAt).toISOString(),
    endedAt: null,
  };
  await appendRecord(ports.files, ledger, record);
  return { kind: 'done', record };
}

/** Ends the session's open job `end.id`. Refused for no such open job, another session's, or an end in the future or before its start. */
export async function endJob(ports: JobPorts, ledger: string, end: JobEnd): Promise<JobOutcome> {
  const records = parseLedger((await ports.files.read(ledger)) ?? '').filter((record): record is JobRecord => isJob(record) && record.id === end.id);
  const started = records.find((record) => record.endedAt === null);
  if (started === undefined || records.some((record) => record.endedAt !== null)) {
    return refused(`no open job "${end.id}"`);
  }
  if (started.session !== end.session) {
    return refused(`job "${end.id}" belongs to ${started.session}`);
  }
  if (end.endedAt > end.nowMs) {
    return refused(`a job cannot end in the future (${minuteText(end.endedAt, end.zone)})`);
  }
  const startedAt = Date.parse(started.startedAt);
  if (end.endedAt < startedAt) {
    return refused(`job "${end.id}" started at ${minuteText(startedAt, end.zone)}, after ${minuteText(end.endedAt, end.zone)}`);
  }
  const record: JobRecord = { ...started, endedAt: new Date(end.endedAt).toISOString() };
  await appendRecord(ports.files, ledger, record);
  return { kind: 'done', record };
}
