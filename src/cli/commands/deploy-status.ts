import { snapshotDirOf } from '../../budget/snapshot.ts';
import { claimText, readClaims } from '../../coordinator/claims.ts';
import { holderText, sharesText, type LockState } from '../../coordinator/host-lock.ts';
import { parseLedger } from '../../coordinator/ledger.ts';
import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { blackoutStart, heavyCutoffSpan, type ResetTime } from '../../coordinator/schedule.ts';
import { loadsOf, type Load } from '../../coordinator/windows.ts';
import type { TimeZone } from '../../core/zone.ts';
import { deployRepos, plural, readPending, short, type PendingRead } from '../../deploy/pending.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, nextResetFrom } from '../coordinator-ports.ts';
import { openTeamKit, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

function lockText(state: LockState, zone: TimeZone): string {
  switch (state.kind) {
    case 'free':
      return 'free';
    case 'stale':
      return `free: the lock of ${holderText({ kind: 'held', info: state.info }, zone)} is stale, and the next heavy step removes it`;
    case 'held':
    case 'unknown':
      return holderText(state, zone);
  }
}

function cutoffText(nowMs: number, cutoffUtc: string | undefined, zone: TimeZone): string {
  const span = heavyCutoffSpan(nowMs, cutoffUtc);
  if (span === undefined) {
    return 'none (delivery.schedule.queueCutoffUtc is not set)';
  }
  const inForce = nowMs >= span.from ? 'IN FORCE ' : '';
  return `${inForce}${zone.clockSpan(new Date(span.from), new Date(span.to))} (no heavy step starts)`;
}

function blackoutText(nowMs: number, reset: ResetTime | undefined, hours: number | undefined, zone: TimeZone): string {
  if (hours === undefined) {
    return 'none (delivery.schedule.resetBlackoutHours is not set)';
  }
  if (reset === undefined) {
    return 'unknown: neither the status line nor budget.reset names the weekly token reset';
  }
  const from = blackoutStart(reset, hours);
  const inForce = nowMs >= from ? 'IN FORCE ' : '';
  return `${inForce}${zone.weekdayMinute(new Date(from))} until ${zone.weekdayMinute(new Date(reset.at))} (no merge or deploy; reset from the ${reset.source})`;
}

function loadText(load: Load, zone: TimeZone): string {
  const on = load.targets === 'host' ? 'the whole host' : load.targets.join(',');
  return `  ${load.id} by ${load.session}: ${load.what} on ${on} since ${zone.minute(new Date(load.from))}`;
}

function pendingText(read: PendingRead): string {
  switch (read.kind) {
    case 'pending':
      return `${plural(read.pending.commits.length, 'commit')} pushed, not deployed (${read.pending.range})`;
    case 'none':
      return `nothing to deploy: the main checkout is at origin (${short(read.head)})`;
    case 'refused':
      return `a deploy would refuse: ${read.reason}`;
    case 'failed':
      return `cannot read what is pending: ${read.reason}`;
  }
}

/**
 * `teamrig deploy-status`: the deploy state now, in one read. The host lock's holder (a stale lock is free, since the next
 * queued step removes it), the queue cutoff and the reset blackout, the quiet claims and loads still open, and what each
 * repository with a deploy block has pushed but not deployed; it fetches each main checkout to tell. Exit 0.
 */
export async function deployStatus(_args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const nowMs = runtime.clock.now();
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { delivery, budget } = config;
  const zone = teamZone(config, runtime);
  const places = coordinatorPlaces(delivery, kit.paths);
  const say = (line: string): void => runtime.out.stdout(line);
  const lock = hostLockOf(runtime, places.hostLock, delivery.queue);
  say(`host lock: ${lockText(await lock.state(), zone)}`);
  const shares = await lock.shares();
  if (shares.length > 0) {
    say(`sharing the host: ${sharesText(shares, zone)}`);
  }
  say(`heavy cutoff: ${cutoffText(nowMs, delivery.schedule.queueCutoffUtc, zone)}`);
  const reset = await nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths))(nowMs);
  say(`deploy blackout: ${blackoutText(nowMs, reset, delivery.schedule.resetBlackoutHours, zone)}`);
  const claims = await readClaims(runtime.files, places.claims);
  if (claims.kind === 'unreadable') {
    say(`claims: unreadable (${claims.reason})`);
  } else {
    const open = claims.claims.filter((claim) => Date.parse(claim.until) > nowMs);
    say(`claims: ${open.length === 0 ? 'none' : open.length}`);
    open.forEach((claim) => say(`  ${claimText(claim, zone)}`));
  }
  const loads = loadsOf(parseLedger((await runtime.files.read(places.ledger)) ?? ''), nowMs).filter((load) => load.open);
  say(`loads: ${loads.length === 0 ? 'none' : loads.length}`);
  loads.forEach((load) => say(loadText(load, zone)));
  const repos = deployRepos(delivery, (path) => teamPlace(kit.paths, path));
  if (repos.length === 0) {
    say('deploys: no repository in delivery.repos has a deploy block');
  }
  for (const repo of repos) {
    say(`${repo.name}: ${pendingText(await readPending(runtime.mergeGit, repo))}`);
  }
  return EXIT.ok;
}
