import { claimText, readClaims } from "../../coordinator/claims.js";
import { holderText, sharesText } from "../../coordinator/host-lock.js";
import { parseLedger } from "../../coordinator/ledger.js";
import { coordinatorPlaces, teamPlace } from "../../coordinator/places.js";
import { blackoutStart, heavyCutoffSpan } from "../../coordinator/schedule.js";
import { loadsOf } from "../../coordinator/windows.js";
import { plural, readPending, rollRepos, short } from "../../roll/pending.js";
import { hostLockOf, nextResetFrom } from "../coordinator-ports.js";
import { openTeamKit, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
import { snapshotDirOf } from "./budget.js";
function lockText(state, zone) {
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
function cutoffText(nowMs, cutoffUtc, zone) {
    const span = heavyCutoffSpan(nowMs, cutoffUtc);
    if (span === undefined) {
        return 'none (coordinator.schedule.heavyCutoffUtc is not set)';
    }
    const inForce = nowMs >= span.from ? 'IN FORCE ' : '';
    return `${inForce}${zone.clockSpan(new Date(span.from), new Date(span.to))} (no heavy step starts)`;
}
function blackoutText(nowMs, reset, hours, zone) {
    if (hours === undefined) {
        return 'none (coordinator.schedule.resetBlackoutHours is not set)';
    }
    if (reset === undefined) {
        return 'unknown: neither the status line nor budget.reset names the weekly token reset';
    }
    const from = blackoutStart(reset, hours);
    const inForce = nowMs >= from ? 'IN FORCE ' : '';
    return `${inForce}${zone.weekdayMinute(new Date(from))} until ${zone.weekdayMinute(new Date(reset.at))} (no integrate or roll; reset from the ${reset.source})`;
}
function loadText(load, zone) {
    const on = load.targets === 'host' ? 'the whole host' : load.targets.join(',');
    return `  ${load.id} by ${load.session}: ${load.what} on ${on} since ${zone.minute(new Date(load.from))}`;
}
function pendingText(read) {
    switch (read.kind) {
        case 'pending':
            return `${plural(read.pending.commits.length, 'commit')} pushed, not rolled (${read.pending.range})`;
        case 'none':
            return `nothing to roll: the main checkout is at origin (${short(read.head)})`;
        case 'refused':
            return `a roll would refuse: ${read.reason}`;
        case 'failed':
            return `cannot read what is pending: ${read.reason}`;
    }
}
/**
 * `teamrig deploys`: the deploy state now, in one read. The host lock's holder (a stale lock is free, since the next
 * heavy step removes it), the heavy cutoff and the reset blackout, the quiet claims and loads still open, and what each
 * repository with a roll block has pushed but not rolled; it fetches each main checkout to tell. Exit 0.
 */
export async function deploys(_args, runtime) {
    const nowMs = runtime.clock.now();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { coordinator, budget } = config;
    const zone = teamZone(config, runtime);
    const places = coordinatorPlaces(coordinator, kit.paths);
    const say = (line) => runtime.out.stdout(line);
    const lock = hostLockOf(runtime, places.hostLock, coordinator.heavy);
    say(`host lock: ${lockText(await lock.state(), zone)}`);
    const shares = await lock.shares();
    if (shares.length > 0) {
        say(`sharing the host: ${sharesText(shares, zone)}`);
    }
    say(`heavy cutoff: ${cutoffText(nowMs, coordinator.schedule.heavyCutoffUtc, zone)}`);
    const reset = await nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths))(nowMs);
    say(`deploy blackout: ${blackoutText(nowMs, reset, coordinator.schedule.resetBlackoutHours, zone)}`);
    const claims = await readClaims(runtime.files, places.claims);
    if (claims.kind === 'unreadable') {
        say(`claims: unreadable (${claims.reason})`);
    }
    else {
        const open = claims.claims.filter((claim) => Date.parse(claim.until) > nowMs);
        say(`claims: ${open.length === 0 ? 'none' : open.length}`);
        open.forEach((claim) => say(`  ${claimText(claim, zone)}`));
    }
    const loads = loadsOf(parseLedger((await runtime.files.read(places.ledger)) ?? ''), nowMs).filter((load) => load.open);
    say(`loads: ${loads.length === 0 ? 'none' : loads.length}`);
    loads.forEach((load) => say(loadText(load, zone)));
    const repos = rollRepos(coordinator, (path) => teamPlace(kit.paths, path));
    if (repos.length === 0) {
        say('rolls: no repository in coordinator.repos has a roll block');
    }
    for (const repo of repos) {
        say(`${repo.name}: ${pendingText(await readPending(runtime.integrateGit, repo))}`);
    }
    return EXIT.ok;
}
