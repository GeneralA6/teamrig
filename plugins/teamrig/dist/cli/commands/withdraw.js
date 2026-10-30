import { deliveryPlaces } from "../../delivery/places.js";
import { ENV } from "../../core/home.js";
import { UsageError } from "../args.js";
import { hostLockOf } from "../delivery-ports.js";
import { openTeamKit, requireConfig, rosterOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { tabSessionOf } from "./tab-session.js";
/**
 * The session whose steps are withdrawn: `--session` or `$TEAMRIG_SESSION`, else the session this Claude Code tab is
 * bound to. A tab bound to a session withdraws only that session's steps, so naming another one there is refused.
 */
async function ownSessionOf(args, runtime, kit, roster) {
    const session = await tabSessionOf(args, runtime, kit, roster, 'withdraws only its own steps');
    if (session === undefined) {
        throw new UsageError(`--session (or $${ENV.session}) is required outside a tab bound to a session`);
    }
    return session;
}
/** Which of the session's waiting steps to withdraw: `--all`, or those whose purpose holds `--what`; undefined for neither. */
function chosenOf(args) {
    const what = args.flags.get('what');
    const all = args.switches.has('all');
    if (what !== undefined && all) {
        throw new UsageError('give --what <text> or --all, not both');
    }
    if (all) {
        return { picks: () => true, text: undefined };
    }
    if (what === undefined) {
        return undefined;
    }
    if (what.trim() === '') {
        throw new UsageError("--what names text in the step's purpose, such as a queued step's label or a merge's repository");
    }
    return { picks: (waiter) => waiter.purpose.includes(what), text: what };
}
function sinceText(waiter, zone) {
    return `waiting since ${zone.minute(new Date(waiter.arrivedAt))}`;
}
/**
 * The line printed for one ticket: withdrawn, or why it was not (its step went first, or an older teamrig queued it),
 * its wait on the zone's clock.
 */
export function withdrawalText(withdrawal, zone) {
    const { waiter } = withdrawal;
    switch (withdrawal.kind) {
        case 'withdrawn':
            return `WITHDRAWN ${waiter.purpose}, ${sinceText(waiter, zone)}: it stops at its next look`;
        case 'running':
            return `RUNNING ${waiter.purpose}: it took its turn first and runs (pid ${waiter.pid})`;
        case 'left':
            return `LEFT ${waiter.purpose}: it left the line first, having run or given up`;
        case 'kept':
            return `KEPT ${waiter.purpose}, ${sinceText(waiter, zone)}: an older teamrig queued it and runs it anyway (pid ${waiter.pid})`;
    }
}
/**
 * `teamrig withdraw (--what <text> | --all)`: takes this session's steps that wait for the host lock (queue, merge,
 * deploy) out of its line, so a re-ordered or abandoned step leaves it; each stops at its next look and runs nothing.
 * With neither flag it lists them and is refused. Exit 0 when each chosen step was withdrawn or none waits, 1 when
 * one went first or was queued by an older teamrig, 2 refused.
 */
export async function withdraw(args, runtime) {
    const chosen = chosenOf(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const session = await ownSessionOf(args, runtime, kit, await rosterOf(runtime, kit, config));
    const zone = teamZone(config, runtime);
    const lock = hostLockOf(runtime, deliveryPlaces(config.delivery, kit.paths).hostLock, config.delivery.queue);
    if (chosen === undefined) {
        const waiting = (await lock.line()).filter((waiter) => waiter.session === session);
        if (waiting.length === 0) {
            runtime.out.stdout(`NONE no step of ${session} waits for the host lock`);
            return EXIT.ok;
        }
        for (const waiter of waiting) {
            runtime.out.stdout(`WAITING ${waiter.purpose}, ${sinceText(waiter, zone)} (pid ${waiter.pid})`);
        }
        throw new RefusedError('name the steps to withdraw: --what <text in their purpose> or --all');
    }
    const done = await lock.withdraw(session, chosen.picks);
    if (done.length === 0) {
        runtime.out.stdout(`NONE no step of ${session} waits for the host lock${chosen.text === undefined ? '' : ` with "${chosen.text}" in its purpose`}`);
        return EXIT.ok;
    }
    for (const withdrawal of done) {
        runtime.out.stdout(withdrawalText(withdrawal, zone));
    }
    return done.every((withdrawal) => withdrawal.kind === 'withdrawn') ? EXIT.ok : EXIT.failed;
}
