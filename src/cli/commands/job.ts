import type { DeliveryConfig } from '../../config/types.ts';
import type { JobRecord } from '../../delivery/ledger.ts';
import { endJob, startJob, type JobOutcome, type JobPorts } from '../../delivery/jobs.ts';
import { deliveryPlaces } from '../../delivery/places.ts';
import { deployTargetsOf } from '../../delivery/targets.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { requiredFlag, type ParsedArgs } from '../args.ts';
import { callerOf, instantOf, listOf, type TypedTimes } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** What a job command works on: the session, the delivery config, the ledger and the jobs' ports. */
interface JobContext {
  readonly session: string;
  readonly delivery: DeliveryConfig;
  readonly ledger: string;
  readonly scanner: SecretScanner;
  readonly ports: JobPorts;
  /** The team's zone, which a typed `--at` is read in and a time is printed in. */
  readonly zone: TimeZone;
}

async function jobContextOf(args: ParsedArgs, runtime: CliRuntime): Promise<JobContext> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  return {
    session,
    delivery: config.delivery,
    ledger: deliveryPlaces(config.delivery, kit.paths).ledger,
    scanner: new SecretScanner(config.register.secretPatterns),
    ports: { files: runtime.files, newId: () => runtime.newId() },
    zone: teamZone(config, runtime),
  };
}

/** `--targets a,b`: the deploy targets a job disturbs; absent, or naming `host`, the whole host. */
function jobTargetsOf(text: string | undefined): readonly string[] | 'host' {
  if (text === undefined) {
    return 'host';
  }
  const targets = listOf('--targets', text);
  return targets.includes('host') ? 'host' : targets;
}

function recordOf(outcome: JobOutcome): JobRecord {
  if (outcome.kind === 'refused') {
    throw new RefusedError(outcome.reason);
  }
  return outcome.record;
}

/** `--at <time>` in ms, else now. */
function atOf(args: ParsedArgs, times: TypedTimes): number {
  const text = args.flags.get('at');
  return text === undefined ? times.nowMs : instantOf('--at', text, times);
}

/**
 * `teamrig job --what "<what>" [--targets <a,b>|host] [--at <time>]`: declares a background job (a long data
 * script, a backfill) in the ledger from `--at` (default now), so `teamrig stable-periods` names it on the stable periods it overlaps.
 * Refused for a start in the future, a target no repository deploys or a secret in what it is. Exit 0, 2 refused.
 */
export async function job(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const what = requiredFlag(args.flags, 'what');
  const targets = jobTargetsOf(args.flags.get('targets'));
  const nowMs = runtime.clock.now();
  const context = await jobContextOf(args, runtime);
  const startedAt = atOf(args, { nowMs, zone: context.zone });
  const rules = { knownTargets: deployTargetsOf(context.delivery.repos), scanner: context.scanner, nowMs, zone: context.zone };
  const record = recordOf(await startJob(context.ports, context.ledger, rules, { session: context.session, what, targets, startedAt }));
  const on = record.targets === 'host' ? 'the whole host' : record.targets.join(', ');
  runtime.out.stdout(`JOB ${record.id} on ${on} from ${context.zone.minute(new Date(startedAt))} (end it: teamrig job end --id ${record.id})`);
  return EXIT.ok;
}

/**
 * `teamrig job end --id <id> [--at <time>]`: ends this session's job at `--at` (default now). Refused for no such
 * open job, another session's, or an end in the future or before its start. Exit 0, 2 refused.
 */
export async function jobEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = requiredFlag(args.flags, 'id');
  const nowMs = runtime.clock.now();
  const context = await jobContextOf(args, runtime);
  const endedAt = atOf(args, { nowMs, zone: context.zone });
  const record = recordOf(await endJob(context.ports, context.ledger, { session: context.session, id, endedAt, nowMs, zone: context.zone }));
  runtime.out.stdout(`ENDED ${record.id} at ${context.zone.minute(new Date(endedAt))}`);
  return EXIT.ok;
}
