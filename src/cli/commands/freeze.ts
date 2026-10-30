import type { DeliveryConfig } from '../../config/types.ts';
import { addClaim, releaseClaim, type ClaimOutcome, type ClaimPorts } from '../../delivery/freeze-store.ts';
import { claimEndText } from '../../delivery/freezes.ts';
import { deliveryPlaces, type DeliveryPlaces } from '../../delivery/places.ts';
import { parseSpanMinutes } from '../../delivery/schedule.ts';
import { deployTargetsOf } from '../../delivery/targets.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { claimsLockOf } from '../delivery-ports.ts';
import { callerOf, listOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** What a freeze command works on: the session, the coordinator's config and places, and the freezes' ports. */
interface ClaimContext {
  readonly session: string;
  readonly delivery: DeliveryConfig;
  readonly places: DeliveryPlaces;
  readonly secretPatterns: readonly string[];
  readonly ports: ClaimPorts;
}

async function claimContextOf(args: ParsedArgs, runtime: CliRuntime): Promise<ClaimContext> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  const { delivery } = config;
  const places = deliveryPlaces(delivery, kit.paths);
  return {
    session,
    delivery,
    places,
    secretPatterns: config.register.secretPatterns,
    ports: { files: runtime.files, clock: runtime.clock, zone: teamZone(config, runtime), lock: claimsLockOf(runtime, places.claimsLock) },
  };
}

/** The freeze a write returned; a refusal is REFUSED, and a write another writer held up past the wait is FAILED. */
function writtenOrExit<T>(runtime: CliRuntime, outcome: ClaimOutcome<T>): { readonly kind: 'written'; readonly value: T } | { readonly kind: 'exit'; readonly code: ExitCode } {
  switch (outcome.kind) {
    case 'done':
      return { kind: 'written', value: outcome.value };
    case 'refused':
      throw new RefusedError(outcome.reason);
    case 'busy':
      runtime.out.stdout(`FAILED ${outcome.reason}`);
      return { kind: 'exit', code: EXIT.failed };
  }
}

/**
 * `teamrig freeze --targets <a,b> --metric <m> --why "<why>" --for <span>`: a deploy freeze, which holds the merges and
 * deploys of its targets while this session measures, from now for the span (`45m`, `1h30m`; at most
 * `delivery.freezes.maxMinutes`). One per session; refused for a target no repository deploys and for a secret in the
 * metric or reason. Exit 0 frozen, 1 when the freezes stayed busy, 2 refused.
 */
export async function freeze(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const targets = listOf('--targets', requiredFlag(args.flags, 'targets'));
  const metric = requiredFlag(args.flags, 'metric');
  const why = requiredFlag(args.flags, 'why');
  const span = requiredFlag(args.flags, 'for');
  const minutes = parseSpanMinutes(span);
  if (minutes === undefined) {
    throw new UsageError(`--for "${span}" is not a span: minutes, hours or both, such as 45m, 2h or 1h30m`);
  }
  const context = await claimContextOf(args, runtime);
  const { delivery } = context;
  const rules = { maxMinutes: delivery.freezes.maxMinutes, knownTargets: deployTargetsOf(delivery.repos), scanner: new SecretScanner(context.secretPatterns) };
  const written = writtenOrExit(runtime, await addClaim(context.ports, context.places, rules, { session: context.session, targets, metric, why, minutes }));
  if (written.kind === 'exit') {
    return written.code;
  }
  runtime.out.stdout(`FROZEN ${written.value.targets.join(', ')} until ${claimEndText(written.value.until, context.ports.zone)}`);
  return EXIT.ok;
}

/** `teamrig unfreeze`: ends this session's deploy freeze before its time. Exit 0 ended or none held, 1 when the freezes stayed busy, 2 refused. */
export async function unfreeze(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const context = await claimContextOf(args, runtime);
  const written = writtenOrExit(runtime, await releaseClaim(context.ports, context.places, context.session));
  if (written.kind === 'exit') {
    return written.code;
  }
  const ended = written.value;
  runtime.out.stdout(ended === undefined ? 'NONE this session held no freeze' : `UNFROZEN ${ended.targets.join(', ')} (frozen until ${claimEndText(ended.until, context.ports.zone)})`);
  return EXIT.ok;
}
