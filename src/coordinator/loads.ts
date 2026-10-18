import type { Files } from '../core/files.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { formatUtcMinute } from '../core/time.ts';
import { appendRecord, parseLedger, type LedgerRecord, type LoadRecord } from './ledger.ts';

/** A load's id is the start of a new id, unique among the ledger's loads: short enough to type into `teamrig load end`. */
const ID_LENGTH = 8;

/** New ids tried before giving up; with random ids, one clash is already rare. */
const ID_TRIES = 10;

export interface LoadPorts {
  readonly files: Pick<Files, 'read' | 'append'>;
  readonly newId: () => string;
}

export type LoadOutcome = { readonly kind: 'done'; readonly record: LoadRecord } | { readonly kind: 'refused'; readonly reason: string };

/** A load a session declares, from `startedAt` (ms). */
export interface LoadStart {
  readonly session: string;
  readonly what: string;
  readonly targets: readonly string[] | 'host';
  readonly startedAt: number;
}

export interface LoadRules {
  /** The targets the team's repositories deploy; `host` is always known. */
  readonly knownTargets: readonly string[];
  readonly scanner: SecretScanner;
  readonly nowMs: number;
}

/** A session ending its load `id` at `endedAt` (ms). */
export interface LoadEnd {
  readonly session: string;
  readonly id: string;
  readonly endedAt: number;
  readonly nowMs: number;
}

function utc(ms: number): string {
  return `${formatUtcMinute(new Date(ms))} UTC`;
}

function isLoad(record: LedgerRecord): record is LoadRecord {
  return record.type === 'load';
}

function refused(reason: string): LoadOutcome {
  return { kind: 'refused', reason };
}

function startRefusal(rules: LoadRules, start: LoadStart): string | undefined {
  if (start.startedAt > rules.nowMs) {
    return `a load cannot start in the future (${utc(start.startedAt)})`;
  }
  if (start.targets !== 'host') {
    const unknown = start.targets.filter((target) => !rules.knownTargets.includes(target));
    if (unknown.length > 0) {
      return `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a deploy target of this team (known: ${[...rules.knownTargets, 'host'].join(', ')})`;
    }
  }
  return rules.scanner.refusal('what the load is', start.what);
}

function freshId(ports: LoadPorts, taken: ReadonlySet<string>): string {
  for (let tries = 0; tries < ID_TRIES; tries += 1) {
    const id = ports.newId().slice(0, ID_LENGTH);
    if (!taken.has(id)) {
      return id;
    }
  }
  throw new Error(`no free load id after ${ID_TRIES} tries`);
}

/**
 * Declares a background load from `start.startedAt` with a new id, written to the ledger. Refused for a start in the
 * future, a target no repository deploys, or a secret in what it is, since the ledger is shared.
 */
export async function startLoad(ports: LoadPorts, ledger: string, rules: LoadRules, start: LoadStart): Promise<LoadOutcome> {
  const refusal = startRefusal(rules, start);
  if (refusal !== undefined) {
    return refused(refusal);
  }
  const taken = new Set(parseLedger((await ports.files.read(ledger)) ?? '').filter(isLoad).map((load) => load.id));
  const record: LoadRecord = {
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

/** Ends the session's open load `end.id`. Refused for no such open load, another session's, or an end in the future or before its start. */
export async function endLoad(ports: LoadPorts, ledger: string, end: LoadEnd): Promise<LoadOutcome> {
  const records = parseLedger((await ports.files.read(ledger)) ?? '').filter((record): record is LoadRecord => isLoad(record) && record.id === end.id);
  const started = records.find((record) => record.endedAt === null);
  if (started === undefined || records.some((record) => record.endedAt !== null)) {
    return refused(`no open load "${end.id}"`);
  }
  if (started.session !== end.session) {
    return refused(`load "${end.id}" belongs to ${started.session}`);
  }
  if (end.endedAt > end.nowMs) {
    return refused(`a load cannot end in the future (${utc(end.endedAt)})`);
  }
  const startedAt = Date.parse(started.startedAt);
  if (end.endedAt < startedAt) {
    return refused(`load "${end.id}" started at ${utc(startedAt)}, after ${utc(end.endedAt)}`);
  }
  const record: LoadRecord = { ...started, endedAt: new Date(end.endedAt).toISOString() };
  await appendRecord(ports.files, ledger, record);
  return { kind: 'done', record };
}
