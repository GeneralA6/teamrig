import type { TimeZone } from '../../core/zone.ts';
import { holderText, sharesCount, type HostShare, type LockState, type LockWaiter } from '../../delivery/host-lock.ts';
import { parseLedger, type LedgerRecord, type RefusalRecord } from '../../delivery/ledger.ts';
import { holdersText, treeMb, type HostMemory, type ProcessRow } from '../../delivery/memory.ts';
import { deliveryPlaces } from '../../delivery/places.ts';
import { minutesText } from '../../delivery/schedule.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf } from '../delivery-ports.ts';
import { openTeamKit, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

const MINUTE_MS = 60_000;

/** How far back REFUSED looks: a day, the span the pipeline trial compares day by day. */
export const REFUSED_SPAN_MS = 24 * 60 * MINUTE_MS;

/** The whole minutes from `fromIso` to `nowMs` as a short duration (`4m`, `1h05m`); none for a time ahead of now. */
function spanText(fromIso: string, nowMs: number): string {
  return minutesText(Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / MINUTE_MS)));
}

/** What a running step's process tree holds now, `rows` the host's processes; nothing when the host cannot list them. */
function useText(pid: number, rows: readonly ProcessRow[] | undefined): string {
  return rows === undefined ? '' : `, its tree uses ${treeMb(pid, rows)} MB`;
}

/** The pids of the steps running now: the lock's holder, when it holds a live lock, and each step sharing the host. */
function runningPids(state: LockState, shares: readonly HostShare[]): number[] {
  return [...(state.kind === 'held' ? [state.info.pid] : []), ...shares.map((share) => share.pid)];
}

async function hostLines(memory: HostMemory, floorMb: number, shares: readonly HostShare[], pids: readonly number[], rows: readonly ProcessRow[] | undefined): Promise<string[]> {
  const parts = [`${memory.freeMb()} MB free of ${memory.totalMb()} MB, ${floorMb} MB kept free (delivery.queue.memoryFloorMb)`];
  const commit = await memory.commit();
  if (commit !== undefined) {
    parts.push(`commit charge ${commit.usedMb} of ${commit.limitMb} MB`);
  }
  if (shares.length > 0) {
    const heldMb = shares.reduce((total, share) => total + share.reserveMb, 0);
    parts.push(`${heldMb} MB held for ${sharesCount(shares)}`);
  }
  if (pids.length > 0) {
    parts.push(rows === undefined ? "the running steps' trees unknown (the host lists no processes)" : `the running steps' trees use ${pids.reduce((total, pid) => total + treeMb(pid, rows), 0)} MB`);
  }
  const holders = await memory.holders();
  const named = holders === undefined ? undefined : holdersText(holders);
  return [`HOST ${parts.join('; ')}`, ...(named === undefined ? [] : [`  ${named}`])];
}

function runningLines(state: LockState, shares: readonly HostShare[], rows: readonly ProcessRow[] | undefined, nowMs: number, zone: TimeZone): string[] {
  const lines: string[] = [];
  switch (state.kind) {
    case 'held':
      lines.push(`  ${state.info.session} (${state.info.purpose}) holds the lock, for ${spanText(state.info.acquiredAt, nowMs)}${useText(state.info.pid, rows)}`);
      break;
    case 'stale':
      lines.push(`  the host lock is free: the lock of ${holderText({ kind: 'held', info: state.info }, zone)} is stale, and the next step removes it`);
      break;
    case 'unknown':
      lines.push(`  the host lock's holder is ${holderText(state, zone)}`);
      break;
    case 'free':
      break;
  }
  for (const share of shares) {
    lines.push(`  ${share.session} (${share.purpose}) shares the host, ${share.reserveMb} MB held for it, for ${spanText(share.acquiredAt, nowMs)}${useText(share.pid, rows)}`);
  }
  const count = runningPids(state, shares).length;
  return [`RUNNING ${count === 0 ? 'none' : count}`, ...lines];
}

/** One waiter in line, its place counted from 1: how long it has waited, and what its ticket says it waits on. */
function waiterLine(waiter: LockWaiter, place: number, nowMs: number, zone: TimeZone): string {
  const head = `  ${place}. ${waiter.session} (${waiter.purpose}) for ${spanText(waiter.arrivedAt, nowMs)}`;
  const on = waiter.waitingOn;
  if (on === undefined) {
    return `${head}: its ticket names no cause (before its first look, or an older teamrig)`;
  }
  return `${head}, on ${on.reason} since ${zone.minute(new Date(on.since))}: ${on.text}`;
}

function isRecentRefusal(record: LedgerRecord, fromMs: number): record is RefusalRecord {
  return record.type === 'refusal' && Date.parse(record.endedAt) >= fromMs;
}

function refusalLine(record: RefusalRecord, zone: TimeZone): string {
  const waited = spanText(record.queuedAt, Date.parse(record.endedAt));
  return `  ${zone.minute(new Date(record.endedAt))} ${record.session} (${record.what}) ${record.outcome} after ${waited}: ${record.reason}`;
}

/**
 * `teamrig pipeline`: the host's steps now, in one read, taking and removing nothing. HOST: free memory, RAM and the
 * floor, the commit charge, the MB held for the steps sharing the host (by kind: heavy, small), what the running steps'
 * process trees use, and the programs holding the most memory. RUNNING: the lock's holder and each step sharing the
 * host, with its run time, the MB held for it and what its tree uses. WAITING: the line in order, each with how long it has waited and
 * what its ticket says it waits on, with that wait's numbers. REFUSED: the queued steps of the last day that waited and
 * did not run, from the ledger. Exit 0.
 */
export async function pipeline(_args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const nowMs = runtime.clock.now();
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { delivery } = config;
  const zone = teamZone(config, runtime);
  const places = deliveryPlaces(delivery, kit.paths);
  const lock = hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom, config.focus, zone);
  const state = await lock.state();
  const shares = await lock.shares();
  const pids = runningPids(state, shares);
  const rows = pids.length === 0 ? [] : await runtime.memory.processes();
  const line = await lock.line();
  const refused = parseLedger((await runtime.files.read(places.ledger)) ?? '').filter((record) => isRecentRefusal(record, nowMs - REFUSED_SPAN_MS));
  const lines = [
    ...(await hostLines(runtime.memory, delivery.queue.memoryFloorMb, shares, pids, rows)),
    ...runningLines(state, shares, rows, nowMs, zone),
    `WAITING ${line.length === 0 ? 'none' : line.length}`,
    ...line.map((waiter, index) => waiterLine(waiter, index + 1, nowMs, zone)),
    `REFUSED in the last 24h: ${refused.length === 0 ? 'none' : refused.length}`,
    ...refused.map((record) => refusalLine(record, zone)),
  ];
  lines.forEach((text) => runtime.out.stdout(text));
  return EXIT.ok;
}
