import type { DeployRecord, QueuedStepRecord, LedgerMdDeploy, LedgerRecord, JobRecord } from './ledger.ts';

const MINUTE_MS = 60_000;

/** A stretch of time, in ms. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** A stretch that spoils a measurement of its targets; `host` spoils every target. */
export interface Disruption extends Span {
  readonly targets: readonly string[] | 'host';
}

export interface DisruptionInputs {
  readonly md: readonly LedgerMdDeploy[];
  readonly records: readonly LedgerRecord[];
  /** What a deploy of a repository disturbs; none for a repository the config does not name. */
  readonly targetsOf: (repo: string) => readonly string[];
  /** How long a target takes to settle after a deploy reached it. */
  readonly settleMs: number;
  /** How long a deploy is taken to have run when the ledger has no record of its start. */
  readonly assumedDeployMs: number;
  /** The host lock's time to live: no queued step holds the host longer. */
  readonly lockTtlMs: number;
  readonly nowMs: number;
}

/**
 * A background job a session declared (`teamrig job`). It never cuts a stable period: it may run for days, and a
 * period inside it still compares with another under the same job, so a period only names the jobs it overlaps.
 */
export interface Job extends Span {
  readonly id: string;
  readonly session: string;
  readonly what: string;
  readonly targets: readonly string[] | 'host';
  /** Not ended yet: it runs until now. */
  readonly open: boolean;
}

function isDeploy(record: LedgerRecord): record is DeployRecord {
  return record.type === 'deploy';
}

function isQueuedStep(record: LedgerRecord): record is QueuedStepRecord {
  return record.type === 'heavy';
}

function isJob(record: LedgerRecord): record is JobRecord {
  return record.type === 'load';
}

function touches(targets: readonly string[] | 'host', target: string): boolean {
  return targets === 'host' || targets.includes(target);
}

/**
 * The deploys and queued steps of the ledger as disruptions. A deploy comes from its ledger.md line, which a session
 * may write by hand; a deploy record of the same session and repository in the same minute gives its real start, else
 * it is taken to have run for `assumedDeployMs`. It disturbs the targets that record names, else its repository's,
 * until `settleMs` after it deployed. A queued step loads the whole host. One with no end record is still running, or was killed before it could
 * write one: it ends at the first of now, the next queued step's start (the host lock is exclusive, so it was free by
 * then) and its start plus the lock's time to live.
 */
export function disruptions(input: DisruptionInputs): Disruption[] {
  const deploys = input.records.filter(isDeploy);
  const fromDeploys = input.md.map((line): Disruption => {
    const minute = Math.floor(line.rolledAt / MINUTE_MS);
    const twin = deploys.find((record) => record.session === line.session && record.repo === line.repo && Math.floor(Date.parse(record.rolledAt) / MINUTE_MS) === minute);
    return {
      from: twin === undefined ? line.rolledAt - input.assumedDeployMs : Date.parse(twin.startedAt),
      to: line.rolledAt + input.settleMs,
      targets: twin?.targets ?? input.targetsOf(line.repo),
    };
  });
  const steps = input.records.filter(isQueuedStep);
  const starts = steps.map((step) => Date.parse(step.startedAt));
  const byId = new Map<string, Disruption>();
  for (const step of steps) {
    if (byId.has(step.id) && step.endedAt === null) {
      continue;
    }
    const from = Date.parse(step.startedAt);
    byId.set(step.id, { from, to: step.endedAt === null ? unfinishedEnd(from, starts, input) : Date.parse(step.endedAt), targets: 'host' });
  }
  return [...fromDeploys, ...byId.values()];
}

function unfinishedEnd(from: number, starts: readonly number[], input: Pick<DisruptionInputs, 'lockTtlMs' | 'nowMs'>): number {
  return starts.reduce((end, start) => (start > from && start < end ? start : end), Math.min(input.nowMs, from + input.lockTtlMs));
}

/** One job per id, its end record winning; one with no end record runs until now. */
export function jobsOf(records: readonly LedgerRecord[], nowMs: number): Job[] {
  const byId = new Map<string, Job>();
  for (const record of records.filter(isJob)) {
    if (byId.has(record.id) && record.endedAt === null) {
      continue;
    }
    byId.set(record.id, {
      id: record.id,
      session: record.session,
      what: record.what,
      targets: record.targets,
      from: Date.parse(record.startedAt),
      to: record.endedAt === null ? nowMs : Date.parse(record.endedAt),
      open: record.endedAt === null,
    });
  }
  return [...byId.values()];
}

/** The jobs on `target` that overlap `span`. */
export function jobsDuring(jobs: readonly Job[], target: string, span: Span): Job[] {
  return jobs.filter((job) => touches(job.targets, target) && job.to > span.from && job.from < span.to);
}

/** The parts of `span` that no disruption of `target` covers, each at least `minMs` long. */
export function stablePeriodsOf(all: readonly Disruption[], target: string, span: Span, minMs: number): Span[] {
  const relevant = all.filter((disruption) => touches(disruption.targets, target) && disruption.to > span.from && disruption.from < span.to).sort((a, b) => a.from - b.from);
  const found: Span[] = [];
  let cursor = span.from;
  for (const disruption of relevant) {
    if (disruption.from > cursor) {
      found.push({ from: cursor, to: disruption.from });
    }
    cursor = Math.max(cursor, disruption.to);
  }
  if (cursor < span.to) {
    found.push({ from: cursor, to: span.to });
  }
  return found.filter((period) => period.to - period.from >= minMs);
}
