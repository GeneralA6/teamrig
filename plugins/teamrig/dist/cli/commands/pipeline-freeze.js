import { SecretScanner } from "../../core/secrets.js";
import { deliveryPlaces } from "../../delivery/places.js";
import { addPipelineFreeze, endPipelineFreeze, pipelineFreezeText } from "../../delivery/pipeline-freezes.js";
import { isStepKind, STEP_KINDS } from "../../delivery/process-request.js";
import { requiredFlag, UsageError } from "../args.js";
import { pipelineFreezesLockOf } from "../delivery-ports.js";
import { callerOf, instantOf, listOf } from "../inputs.js";
import { leadOrDeliveryOwnerOnly, openTeamKit, requireConfig, rosterOf, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
import { writtenOrExit } from "./freeze.js";
/** The context, the caller refused unless it is the lead or the delivery owner, since a freeze holds every team's steps. */
async function contextOf(args, runtime, what) {
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
function kindsOf(text) {
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
export async function pipelineFreeze(args, runtime) {
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
export async function pipelineUnfreeze(args, runtime) {
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
