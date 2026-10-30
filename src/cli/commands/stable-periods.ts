import type { DeliveryConfig } from '../../config/types.ts';
import { parseLedger, parseLedgerMd } from '../../delivery/ledger.ts';
import { deliveryPlaces } from '../../delivery/places.ts';
import { minutesText, parseSpanMinutes } from '../../delivery/schedule.ts';
import { deployTargetsOf, repoTargetsOf } from '../../delivery/targets.ts';
import { stablePeriodsOf, disruptions, jobsDuring, jobsOf, type Job, type Span } from '../../delivery/stable-periods.ts';
import type { TimeZone } from '../../core/zone.ts';
import { requiredFlag, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { instantOf, listOf, type TypedTimes } from '../inputs.ts';
import { openTeamKit, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

const MINUTE_MS = 60_000;

/** An instant as the team reads it: `2030-01-08 12:00 IST`. */
function minuteText(ms: number, zone: TimeZone): string {
  return zone.minute(new Date(ms));
}

/** `--settle 1h`: a span in minutes; undefined when the flag is absent. */
function spanFlag(flags: Flags, name: string): number | undefined {
  const text = flags.get(name);
  if (text === undefined) {
    return undefined;
  }
  const minutes = parseSpanMinutes(text);
  if (minutes === undefined) {
    throw new UsageError(`--${name} "${text}" is not a span: minutes, hours or both, such as 45m, 2h or 1h30m`);
  }
  return minutes;
}

function countText(count: number): string {
  return count === 0 ? 'no stable period' : `${count} stable period${count === 1 ? '' : 's'}`;
}

function periodLine(period: Span, zone: TimeZone): string {
  return `  ${minuteText(period.from, zone)} to ${minuteText(period.to, zone)} (${minutesText(Math.round((period.to - period.from) / MINUTE_MS))})`;
}

function jobLine(job: Job, zone: TimeZone): string {
  return `    under job ${job.id} by ${job.session}: ${job.what} (from ${minuteText(job.from, zone)}, ${job.open ? 'still running' : `ended ${minuteText(job.to, zone)}`})`;
}

/** What `stable-periods` measures in: the span, each target's settle time and the shortest period worth naming. */
interface PeriodAsk {
  readonly targets: readonly string[];
  readonly span: Span;
  readonly settleMinutes: (target: string) => number;
  readonly minMinutes: number;
}

function askOf(flags: Flags, delivery: DeliveryConfig, times: TypedTimes): PeriodAsk {
  const { nowMs } = times;
  const targets = listOf('--targets', requiredFlag(flags, 'targets'));
  const known = deployTargetsOf(delivery.repos);
  const unknown = targets.filter((target) => !known.includes(target));
  if (unknown.length > 0) {
    throw new UsageError(`--targets: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a deploy target of this team (known: ${known.join(', ')})`);
  }
  const since = instantOf('--since', requiredFlag(flags, 'since'), times);
  const untilText = flags.get('until');
  const until = Math.min(nowMs, untilText === undefined ? nowMs : instantOf('--until', untilText, times));
  if (until <= since) {
    throw new UsageError(`--since ${minuteText(since, times.zone)} is not before ${untilText === undefined ? 'now' : '--until'} (${minuteText(until, times.zone)})`);
  }
  const settle = spanFlag(flags, 'settle');
  const perTarget = new Map(Object.entries(delivery.stablePeriods.targetSettleMinutes));
  return {
    targets,
    span: { from: since, to: until },
    settleMinutes: (target) => settle ?? perTarget.get(target) ?? delivery.stablePeriods.settleMinutes,
    minMinutes: spanFlag(flags, 'min') ?? delivery.stablePeriods.minMinutes,
  };
}

/**
 * `teamrig stable-periods --targets <a,b> --since <time> [--until <time>] [--settle <span>] [--min <span>]`: the
 * stable periods of each target, so a session compares a metric over stretches no change touched. A deploy of a
 * repository that deploys the target disturbs it from the deploy's start until it settled, unless its record names
 * other targets (`deploy --targets`); a queued step disturbs the whole host. Each period names the declared jobs
 * (`teamrig job`) it overlaps. `--until` is cut to now.
 */
export async function stablePeriods(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const nowMs = runtime.clock.now();
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { delivery } = config;
  const zone = teamZone(config, runtime);
  const ask = askOf(args.flags, delivery, { nowMs, zone });
  const places = deliveryPlaces(delivery, kit.paths);
  const records = parseLedger((await runtime.files.read(places.ledger)) ?? '');
  const md = parseLedgerMd((await runtime.files.read(places.ledgerMd)) ?? '');
  const repoTargets = new Map(Object.entries(delivery.repos).map(([name, repo]) => [name, repoTargetsOf(repo)]));
  const jobs = jobsOf(records, nowMs);
  for (const target of ask.targets) {
    const settle = ask.settleMinutes(target);
    const all = disruptions({
      md,
      records,
      targetsOf: (repo) => repoTargets.get(repo) ?? [],
      settleMs: settle * MINUTE_MS,
      assumedDeployMs: delivery.stablePeriods.assumedDeployMinutes * MINUTE_MS,
      lockTtlMs: delivery.queue.lockTtlMinutes * MINUTE_MS,
      nowMs,
    });
    const found = stablePeriodsOf(all, target, ask.span, ask.minMinutes * MINUTE_MS);
    runtime.out.stdout(`${target} (settle ${minutesText(settle)}): ${countText(found.length)} of at least ${minutesText(ask.minMinutes)}`);
    for (const period of found) {
      runtime.out.stdout(periodLine(period, zone));
      jobsDuring(jobs, target, period).forEach((job) => runtime.out.stdout(jobLine(job, zone)));
    }
  }
  return EXIT.ok;
}
