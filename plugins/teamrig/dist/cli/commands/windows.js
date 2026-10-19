import { parseLedger, parseLedgerMd } from "../../coordinator/ledger.js";
import { coordinatorPlaces } from "../../coordinator/places.js";
import { minutesText, parseSpanMinutes } from "../../coordinator/schedule.js";
import { deployTargetsOf, repoTargetsOf } from "../../coordinator/targets.js";
import { cleanWindows, disruptions, loadsDuring, loadsOf } from "../../coordinator/windows.js";
import { requiredFlag, UsageError } from "../args.js";
import { instantOf, listOf } from "../inputs.js";
import { openTeamKit, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
const MINUTE_MS = 60_000;
/** An instant as the team reads it: `2030-01-08 12:00 IST`. */
function minuteText(ms, zone) {
    return zone.minute(new Date(ms));
}
/** `--settle 1h`: a span in minutes; undefined when the flag is absent. */
function spanFlag(flags, name) {
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
function countText(count) {
    return count === 0 ? 'no clean window' : `${count} clean window${count === 1 ? '' : 's'}`;
}
function windowLine(window, zone) {
    return `  ${minuteText(window.from, zone)} to ${minuteText(window.to, zone)} (${minutesText(Math.round((window.to - window.from) / MINUTE_MS))})`;
}
function loadLine(load, zone) {
    return `    under load ${load.id} by ${load.session}: ${load.what} (from ${minuteText(load.from, zone)}, ${load.open ? 'still running' : `ended ${minuteText(load.to, zone)}`})`;
}
function askOf(flags, coordinator, times) {
    const { nowMs } = times;
    const targets = listOf('--targets', requiredFlag(flags, 'targets'));
    const known = deployTargetsOf(coordinator.repos);
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
    const perTarget = new Map(Object.entries(coordinator.windows.targetSettleMinutes));
    return {
        targets,
        span: { from: since, to: until },
        settleMinutes: (target) => settle ?? perTarget.get(target) ?? coordinator.windows.settleMinutes,
        minMinutes: spanFlag(flags, 'min') ?? coordinator.windows.minMinutes,
    };
}
/**
 * `teamrig windows --targets <a,b> --since <time> [--until <time>] [--settle <span>] [--min <span>]`: the clean
 * measurement windows of each target, so a session compares a metric over stretches no change touched. A deploy of a
 * repository that deploys the target disturbs it from the deploy's start until it settled; a heavy step disturbs the
 * whole host. Each window names the declared loads (`teamrig load`) it overlaps. `--until` is cut to now.
 */
export async function windows(args, runtime) {
    const nowMs = runtime.clock.now();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { coordinator } = config;
    const zone = teamZone(config, runtime);
    const ask = askOf(args.flags, coordinator, { nowMs, zone });
    const places = coordinatorPlaces(coordinator, kit.paths);
    const records = parseLedger((await runtime.files.read(places.ledger)) ?? '');
    const md = parseLedgerMd((await runtime.files.read(places.ledgerMd)) ?? '');
    const repoTargets = new Map(Object.entries(coordinator.repos).map(([name, repo]) => [name, repoTargetsOf(repo)]));
    const loads = loadsOf(records, nowMs);
    for (const target of ask.targets) {
        const settle = ask.settleMinutes(target);
        const all = disruptions({
            md,
            records,
            targetsOf: (repo) => repoTargets.get(repo) ?? [],
            settleMs: settle * MINUTE_MS,
            assumedRollMs: coordinator.windows.assumedRollMinutes * MINUTE_MS,
            lockTtlMs: coordinator.heavy.lockTtlMinutes * MINUTE_MS,
            nowMs,
        });
        const found = cleanWindows(all, target, ask.span, ask.minMinutes * MINUTE_MS);
        runtime.out.stdout(`${target} (settle ${minutesText(settle)}): ${countText(found.length)} of at least ${minutesText(ask.minMinutes)}`);
        for (const window of found) {
            runtime.out.stdout(windowLine(window, zone));
            loadsDuring(loads, target, window).forEach((load) => runtime.out.stdout(loadLine(load, zone)));
        }
    }
    return EXIT.ok;
}
