import { addClaim, releaseClaim } from "../../coordinator/claim-store.js";
import { coordinatorPlaces } from "../../coordinator/places.js";
import { parseSpanMinutes } from "../../coordinator/schedule.js";
import { deployTargetsOf } from "../../coordinator/targets.js";
import { SecretScanner } from "../../core/secrets.js";
import { formatUtcMinute } from "../../core/time.js";
import { requiredFlag, UsageError } from "../args.js";
import { claimsLockOf } from "../coordinator-ports.js";
import { callerOf, listOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
async function claimContextOf(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const { coordinator } = config;
    const places = coordinatorPlaces(coordinator, kit.paths);
    return {
        session,
        coordinator,
        places,
        secretPatterns: config.register.secretPatterns,
        ports: { files: runtime.files, clock: runtime.clock, lock: claimsLockOf(runtime, places.claimsLock) },
    };
}
function untilText(claim) {
    return `${formatUtcMinute(new Date(Date.parse(claim.until)))} UTC`;
}
/** The claim a write returned; a refusal is REFUSED, and a write another writer held up past the wait is FAILED. */
function writtenOrExit(runtime, outcome) {
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
 * `teamrig claim --targets <a,b> --metric <m> --why "<why>" --for <span>`: a quiet claim, which holds the integrates and
 * rolls that deploy its targets while this session measures, from now for the span (`45m`, `1h30m`; at most
 * `coordinator.claims.maxMinutes`). One per session; refused for a target no repository deploys and for a secret in the
 * metric or reason. Exit 0 claimed, 1 when the claims stayed busy, 2 refused.
 */
export async function claim(args, runtime) {
    const targets = listOf('--targets', requiredFlag(args.flags, 'targets'));
    const metric = requiredFlag(args.flags, 'metric');
    const why = requiredFlag(args.flags, 'why');
    const span = requiredFlag(args.flags, 'for');
    const minutes = parseSpanMinutes(span);
    if (minutes === undefined) {
        throw new UsageError(`--for "${span}" is not a span: minutes, hours or both, such as 45m, 2h or 1h30m`);
    }
    const context = await claimContextOf(args, runtime);
    const { coordinator } = context;
    const rules = { maxMinutes: coordinator.claims.maxMinutes, knownTargets: deployTargetsOf(coordinator.repos), scanner: new SecretScanner(context.secretPatterns) };
    const written = writtenOrExit(runtime, await addClaim(context.ports, context.places, rules, { session: context.session, targets, metric, why, minutes }));
    if (written.kind === 'exit') {
        return written.code;
    }
    runtime.out.stdout(`CLAIMED ${written.value.targets.join(', ')} until ${untilText(written.value)}`);
    return EXIT.ok;
}
/** `teamrig release`: ends this session's quiet claim before its time. Exit 0 ended or none held, 1 when the claims stayed busy, 2 refused. */
export async function release(args, runtime) {
    const context = await claimContextOf(args, runtime);
    const written = writtenOrExit(runtime, await releaseClaim(context.ports, context.places, context.session));
    if (written.kind === 'exit') {
        return written.code;
    }
    const ended = written.value;
    runtime.out.stdout(ended === undefined ? 'NONE this session held no claim' : `RELEASED ${ended.targets.join(', ')} (claimed until ${untilText(ended)})`);
    return EXIT.ok;
}
