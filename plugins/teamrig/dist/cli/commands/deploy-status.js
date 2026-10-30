import { snapshotDirOf } from "../../budget/snapshot.js";
import { quietClaimText, readFreezes } from "../../delivery/freezes.js";
import { holderText, sharesText } from "../../delivery/host-lock.js";
import { parseLedger } from "../../delivery/ledger.js";
import { deliveryPlaces, teamPlace } from "../../delivery/places.js";
import { blackoutStart, queueCutoffSpan } from "../../delivery/schedule.js";
import { jobsOf } from "../../delivery/stable-periods.js";
import { deployRepos, plural, readPending, short } from "../../deploy/pending.js";
import { hostLockOf, nextResetFrom } from "../delivery-ports.js";
import { openTeamKit, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
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
    const span = queueCutoffSpan(nowMs, cutoffUtc);
    if (span === undefined) {
        return 'none (delivery.schedule.queueCutoffUtc is not set)';
    }
    const inForce = nowMs >= span.from ? 'IN FORCE ' : '';
    return `${inForce}${zone.clockSpan(new Date(span.from), new Date(span.to))} (no heavy step starts)`;
}
function blackoutText(nowMs, reset, hours, zone) {
    if (hours === undefined) {
        return 'none (delivery.schedule.resetBlackoutHours is not set)';
    }
    if (reset === undefined) {
        return 'unknown: neither the status line nor budget.reset names the weekly token reset';
    }
    const from = blackoutStart(reset, hours);
    const inForce = nowMs >= from ? 'IN FORCE ' : '';
    return `${inForce}${zone.weekdayMinute(new Date(from))} until ${zone.weekdayMinute(new Date(reset.at))} (no merge or deploy; reset from the ${reset.source})`;
}
function jobText(job, zone) {
    const on = job.targets === 'host' ? 'the whole host' : job.targets.join(',');
    return `  ${job.id} by ${job.session}: ${job.what} on ${on} since ${zone.minute(new Date(job.from))}`;
}
function pendingText(read) {
    switch (read.kind) {
        case 'pending':
            return `${plural(read.pending.commits.length, 'commit')} pushed, not deployed (${read.pending.range})`;
        case 'none':
            return `nothing to deploy: the main checkout is at origin (${short(read.head)})`;
        case 'refused':
            return `a deploy would refuse: ${read.reason}`;
        case 'failed':
            return `cannot read what is pending: ${read.reason}`;
    }
}
/**
 * `teamrig deploy-status`: the deploy state now, in one read. The host lock's holder (a stale lock is free, since the next
 * queued step removes it), the queue cutoff and the reset blackout, the deploy freezes and background jobs still open
 * (its `claims:` and `loads:` lines, which keep their old names for the tools that read them), and what each repository
 * with a deploy block has pushed but not deployed; it fetches each main checkout to tell. Exit 0.
 */
export async function deployStatus(_args, runtime) {
    const nowMs = runtime.clock.now();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { delivery, budget } = config;
    const zone = teamZone(config, runtime);
    const places = deliveryPlaces(delivery, kit.paths);
    const say = (line) => runtime.out.stdout(line);
    const lock = hostLockOf(runtime, places.hostLock, delivery.queue);
    say(`host lock: ${lockText(await lock.state(), zone)}`);
    const shares = await lock.shares();
    if (shares.length > 0) {
        say(`sharing the host: ${sharesText(shares, zone)}`);
    }
    say(`heavy cutoff: ${cutoffText(nowMs, delivery.schedule.queueCutoffUtc, zone)}`);
    const reset = await nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths))(nowMs);
    say(`deploy blackout: ${blackoutText(nowMs, reset, delivery.schedule.resetBlackoutHours, zone)}`);
    const freezes = await readFreezes(runtime.files, places.freezes);
    if (freezes.kind === 'unreadable') {
        say(`claims: unreadable (${freezes.reason})`);
    }
    else {
        const open = freezes.freezes.filter((freeze) => Date.parse(freeze.until) > nowMs);
        say(`claims: ${open.length === 0 ? 'none' : open.length}`);
        open.forEach((freeze) => say(`  ${quietClaimText(freeze, zone)}`));
    }
    const jobs = jobsOf(parseLedger((await runtime.files.read(places.ledger)) ?? ''), nowMs).filter((job) => job.open);
    say(`loads: ${jobs.length === 0 ? 'none' : jobs.length}`);
    jobs.forEach((job) => say(jobText(job, zone)));
    const repos = deployRepos(delivery, (path) => teamPlace(kit.paths, path));
    if (repos.length === 0) {
        say('deploys: no repository in delivery.repos has a deploy block');
    }
    for (const repo of repos) {
        say(`${repo.name}: ${pendingText(await readPending(runtime.mergeGit, repo))}`);
    }
    return EXIT.ok;
}
