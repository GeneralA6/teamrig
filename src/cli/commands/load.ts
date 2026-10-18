import type { CoordinatorConfig } from '../../config/types.ts';
import type { LoadRecord } from '../../coordinator/ledger.ts';
import { endLoad, startLoad, type LoadOutcome, type LoadPorts } from '../../coordinator/loads.ts';
import { coordinatorPlaces } from '../../coordinator/places.ts';
import { deployTargetsOf } from '../../coordinator/targets.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { formatUtcMinute } from '../../core/time.ts';
import { requiredFlag, type ParsedArgs } from '../args.ts';
import { callerOf, instantOf, listOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** What a load command works on: the session, the coordinator's config, the ledger and the loads' ports. */
interface LoadContext {
  readonly session: string;
  readonly coordinator: CoordinatorConfig;
  readonly ledger: string;
  readonly scanner: SecretScanner;
  readonly ports: LoadPorts;
}

async function loadContextOf(args: ParsedArgs, runtime: CliRuntime): Promise<LoadContext> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  return {
    session,
    coordinator: config.coordinator,
    ledger: coordinatorPlaces(config.coordinator, kit.paths).ledger,
    scanner: new SecretScanner(config.register.secretPatterns),
    ports: { files: runtime.files, newId: () => runtime.newId() },
  };
}

/** `--targets a,b`: the deploy targets a load disturbs; absent, or naming `host`, the whole host. */
function loadTargetsOf(text: string | undefined): readonly string[] | 'host' {
  if (text === undefined) {
    return 'host';
  }
  const targets = listOf('--targets', text);
  return targets.includes('host') ? 'host' : targets;
}

function recordOf(outcome: LoadOutcome): LoadRecord {
  if (outcome.kind === 'refused') {
    throw new RefusedError(outcome.reason);
  }
  return outcome.record;
}

/** `--at <time>` in ms, else now. */
function atOf(args: ParsedArgs, nowMs: number): number {
  const text = args.flags.get('at');
  return text === undefined ? nowMs : instantOf('--at', text, nowMs);
}

function utc(ms: number): string {
  return `${formatUtcMinute(new Date(ms))} UTC`;
}

/**
 * `teamrig load --what "<what>" [--targets <a,b>|host] [--at <time>]`: declares a background load (a long data
 * script, a backfill) in the ledger from `--at` (default now), so `teamrig windows` names it on the windows it overlaps.
 * Refused for a start in the future, a target no repository deploys or a secret in what it is. Exit 0, 2 refused.
 */
export async function load(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const what = requiredFlag(args.flags, 'what');
  const targets = loadTargetsOf(args.flags.get('targets'));
  const nowMs = runtime.clock.now();
  const startedAt = atOf(args, nowMs);
  const context = await loadContextOf(args, runtime);
  const rules = { knownTargets: deployTargetsOf(context.coordinator.repos), scanner: context.scanner, nowMs };
  const record = recordOf(await startLoad(context.ports, context.ledger, rules, { session: context.session, what, targets, startedAt }));
  const on = record.targets === 'host' ? 'the whole host' : record.targets.join(', ');
  runtime.out.stdout(`LOAD ${record.id} on ${on} from ${utc(startedAt)} (end it: teamrig load end --id ${record.id})`);
  return EXIT.ok;
}

/**
 * `teamrig load end --id <id> [--at <time>]`: ends this session's load at `--at` (default now). Refused for no such
 * open load, another session's, or an end in the future or before its start. Exit 0, 2 refused.
 */
export async function loadEnd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = requiredFlag(args.flags, 'id');
  const nowMs = runtime.clock.now();
  const endedAt = atOf(args, nowMs);
  const context = await loadContextOf(args, runtime);
  const record = recordOf(await endLoad(context.ports, context.ledger, { session: context.session, id, endedAt, nowMs }));
  runtime.out.stdout(`ENDED ${record.id} at ${utc(endedAt)}`);
  return EXIT.ok;
}
