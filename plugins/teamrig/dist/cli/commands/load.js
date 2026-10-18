import { endLoad, startLoad } from "../../coordinator/loads.js";
import { coordinatorPlaces } from "../../coordinator/places.js";
import { deployTargetsOf } from "../../coordinator/targets.js";
import { SecretScanner } from "../../core/secrets.js";
import { formatUtcMinute } from "../../core/time.js";
import { requiredFlag } from "../args.js";
import { callerOf, instantOf, listOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
async function loadContextOf(args, runtime) {
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
function loadTargetsOf(text) {
    if (text === undefined) {
        return 'host';
    }
    const targets = listOf('--targets', text);
    return targets.includes('host') ? 'host' : targets;
}
function recordOf(outcome) {
    if (outcome.kind === 'refused') {
        throw new RefusedError(outcome.reason);
    }
    return outcome.record;
}
/** `--at <time>` in ms, else now. */
function atOf(args, nowMs) {
    const text = args.flags.get('at');
    return text === undefined ? nowMs : instantOf('--at', text, nowMs);
}
function utc(ms) {
    return `${formatUtcMinute(new Date(ms))} UTC`;
}
/**
 * `teamrig load --what "<what>" [--targets <a,b>|host] [--at <time>]`: declares a background load (a long data
 * script, a backfill) in the ledger from `--at` (default now), so `teamrig windows` names it on the windows it overlaps.
 * Refused for a start in the future, a target no repository deploys or a secret in what it is. Exit 0, 2 refused.
 */
export async function load(args, runtime) {
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
export async function loadEnd(args, runtime) {
    const id = requiredFlag(args.flags, 'id');
    const nowMs = runtime.clock.now();
    const endedAt = atOf(args, nowMs);
    const context = await loadContextOf(args, runtime);
    const record = recordOf(await endLoad(context.ports, context.ledger, { session: context.session, id, endedAt, nowMs }));
    runtime.out.stdout(`ENDED ${record.id} at ${utc(endedAt)}`);
    return EXIT.ok;
}
