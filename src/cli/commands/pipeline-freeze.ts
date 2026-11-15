import { SecretScanner } from '../../core/secrets.ts';
import type { FreezePorts } from '../../delivery/freeze-store.ts';
import { deliveryPlaces, type DeliveryPlaces } from '../../delivery/places.ts';
import { addPipelineFreeze, endPipelineFreeze, pipelineFreezeText } from '../../delivery/pipeline-freezes.ts';
import { isStepKind, STEP_KINDS, type StepKind } from '../../delivery/process-request.ts';
import { requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { pipelineFreezesLockOf } from '../delivery-ports.ts';
import { callerOf, instantOf, listOf } from '../inputs.ts';
import { leadOrDeliveryOwnerOnly, openTeamKit, requireConfig, rosterOf, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { writtenOrExit } from './freeze.ts';

/** What a pipeline freeze command works on: the session, the places, the team's secret patterns and the freezes' ports. */
interface PipelineFreezeContext {
  readonly session: string;
  readonly places: DeliveryPlaces;
  readonly secretPatterns: readonly string[];
  readonly ports: FreezePorts;
}

/** The context, the caller refused unless it is the lead or the delivery owner, since a freeze holds every team's steps. */
async function contextOf(args: ParsedArgs, runtime: CliRuntime, what: string): Promise<PipelineFreezeContext> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const session = leadOrDeliveryOwnerOnly(await rosterOf(runtime, kit, config), caller, what);
  const places = deliveryPlaces(config.delivery, kit.paths);
  const zone = teamZone(config, runtime);
  return {
    session,
    places,
    secretPatterns: config.register.secretPatterns,
    ports: { files: runtime.files, clock: runtime.clock, zone, lock: pipelineFreezesLockOf(runtime, places.pipelineFreezesLock, zone) },
  };
}

/** `--kinds test,build`: step kinds, each one of `STEP_KINDS`. */
function kindsOf(text: string): StepKind[] {
  const words = listOf('--kinds', text);
  const kinds = words.filter(isStepKind);
  const unknown = words.filter((word) => !isStepKind(word));
  if (unknown.length > 0) {
    throw new UsageError(`--kinds "${text}": ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a step kind' : 'are not step kinds'} (${STEP_KINDS.join(', ')})`);
  }
  return kinds;
}

/**
 * `teamrig pipeline freeze --to <time> --reason "<why>" [--from <time>] [--kinds <a,b>]`: no new step of the kinds
 * (every kind without --kinds) starts on this host from --from (default now) to --to. Exit 0 frozen, 1 when the
 * freezes stayed busy, 2 refused.
 */
export async function pipelineFreeze(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const context = await contextOf(args, runtime, 'freezes the pipeline');
  const times = { nowMs: runtime.clock.now(), zone: context.ports.zone };
  const fromText = args.flags.get('from');
  const kindsText = args.flags.get('kinds');
  const request = {
    session: context.session,
    from: new Date(fromText === undefined ? times.nowMs : instantOf('--from', fromText, times)),
    to: new Date(instantOf('--to', requiredFlag(args.flags, 'to'), times)),
    reason: requiredFlag(args.flags, 'reason'),
    ...(kindsText === undefined ? {} : { kinds: kindsOf(kindsText) }),
  };
  const written = writtenOrExit(runtime, await addPipelineFreeze(context.ports, context.places, new SecretScanner(context.secretPatterns), request));
  if (written.kind === 'exit') {
    return written.code;
  }
  runtime.out.stdout(`FROZEN ${pipelineFreezeText(written.value, context.ports.zone)}`);
  return EXIT.ok;
}

/** `teamrig pipeline unfreeze <id>`: ends a holding pipeline freeze now, or drops one still to come. Exit 0 ended, 1 busy, 2 refused. */
export async function pipelineUnfreeze(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [id, ...extra] = args.positionals;
  if (id === undefined || extra.length > 0) {
    throw new UsageError('give one pipeline freeze id, such as F3 (teamrig pipeline lists them)');
  }
  const context = await contextOf(args, runtime, 'ends a pipeline freeze');
  const written = writtenOrExit(runtime, await endPipelineFreeze(context.ports, context.places, context.session, id));
  if (written.kind === 'exit') {
    return written.code;
  }
  runtime.out.stdout(`UNFROZEN ${pipelineFreezeText(written.value, context.ports.zone)}`);
  return EXIT.ok;
}
