import { QUEUE_TTL_MARGIN_MINUTES } from "../../config/defaults.js";
import { busyText, holderText, underLock, waitText } from "../../delivery/host-lock.js";
import { parseLedger } from "../../delivery/ledger.js";
import { deliveryPlaces } from "../../delivery/places.js";
import { passOf, PRE_PUSH_MAX_WAIT_MS, recordPass } from "../../delivery/push-pass.js";
import { isStepKind, kindOfCommand, processRequest, STEP_KINDS, taskOfLabel, withTaskPriority } from "../../delivery/process-request.js";
import { recordRefusal, runRecorded } from "../../delivery/recorded-step.js";
import { stepNeedOf } from "../../delivery/step-need.js";
import { causeOfLockWait, WaitLog } from "../../delivery/wait-log.js";
import { queueCutoffReason, minutesText } from "../../delivery/schedule.js";
import { endedText } from "../../delivery/starter-watch.js";
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT } from "../../delivery/steps.js";
import { ENV } from "../../core/home.js";
import { TASK_ID } from "../../register/model.js";
import { JsonlEventLog } from "../../register/store.js";
import { commandLine } from "../../test-run/shell.js";
import { requiredFlag, UsageError } from "../args.js";
import { hostLockOf, logLineOf } from "../delivery-ports.js";
import { commandWordsOf, sessionRef } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { stoppedWhileWaiting, unlessStopped, watchStarters } from "../stoppable.js";
import { envSession, markedSessionOf } from "./hook-input.js";
const MINUTE_MS = 60_000;
/**
 * `--max-minutes`: whole minutes from 1 to the lock's TTL less its margin, so the step never outlives its lock, and for
 * a small step to `smallMaxRunMinutes`, so a step that shares the host stays short; unset, the config's.
 */
function maxRunMinutesOf(args, config, small) {
    const text = args.flags.get('max-minutes');
    if (text === undefined) {
        return small ? config.smallMaxRunMinutes : config.maxRunMinutes;
    }
    const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (small) {
        if (!(minutes >= 1 && minutes <= config.smallMaxRunMinutes)) {
            throw new UsageError(`--max-minutes with --small is a whole number from 1 to ${config.smallMaxRunMinutes} (delivery.queue.smallMaxRunMinutes): a longer step runs without --small`);
        }
        return minutes;
    }
    const longest = config.lockTtlMinutes - QUEUE_TTL_MARGIN_MINUTES;
    if (!(minutes >= 1 && minutes <= longest)) {
        throw new UsageError(`--max-minutes is a whole number from 1 to ${longest} (delivery.queue.lockTtlMinutes less ${QUEUE_TTL_MARGIN_MINUTES})`);
    }
    return minutes;
}
/** `--kind`: one of STEP_KINDS; unset, the kind the command's words show (`kindOfCommand`). */
function kindOf(args, words) {
    const text = args.flags.get('kind');
    if (text === undefined) {
        return kindOfCommand(words);
    }
    if (!isStepKind(text)) {
        throw new UsageError(`--kind is one of ${STEP_KINDS.join(', ')}`);
    }
    return text;
}
/** `--task`: a register task id; unset, the first one the label names (`taskOfLabel`), if any. */
function taskOf(args, what) {
    const text = args.flags.get('task');
    if (text === undefined) {
        return taskOfLabel(what);
    }
    if (!TASK_ID.test(text)) {
        throw new UsageError(`--task is a register task id, such as T12`);
    }
    return text;
}
/** `--memory-mb`: the MB the step declares it needs, a whole number from 1; unset, none (`stepNeedOf` learns it). */
function declaredMbOf(args) {
    const text = args.flags.get('memory-mb');
    if (text === undefined) {
        return undefined;
    }
    const mb = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!(Number.isSafeInteger(mb) && mb >= 1)) {
        throw new UsageError('--memory-mb is a whole number of MB from 1');
    }
    return mb;
}
/** What the step asks for besides its label, recorded on its start and refusal records. */
function requestOf(args, words, what) {
    return processRequest(kindOf(args, words), taskOf(args, what));
}
function refuseAfterCutoff(runtime, cutoffUtc, zone) {
    const reason = queueCutoffReason(runtime.clock.now(), cutoffUtc, zone);
    if (reason !== undefined) {
        throw new RefusedError(reason);
    }
}
/** Refuses a step that waited and did not run, after its refusal record (`recordRefusal`), with the reason it records. */
async function refuseWaited(runtime, ledger, waits, mark) {
    throw new RefusedError(await recordRefusal(runtime, ledger, waits, mark));
}
/**
 * What the step asks of the host (`stepNeedOf`): its need learned from its own past runs in the ledger, or its
 * `--memory-mb`, else the config's default, so a step known to need more waits for that much room.
 */
async function needOf(runtime, ledger, ask, config) {
    return stepNeedOf(parseLedger((await runtime.files.read(ledger)) ?? ''), ask, config);
}
/** The line a small step holding `reserveMb` prints when it shares the host. */
function sharingText(reserveMb, taking) {
    if (taking.sharing === undefined) {
        return undefined;
    }
    const others = taking.sharing.others.length;
    const free = taking.sharing.freeMb === undefined ? '' : `${taking.sharing.freeMb} MB free, `;
    return `sharing the host: ${reserveMb} MB held for it (${free}${others} other small step${others === 1 ? '' : 's'})`;
}
/** The last line: DONE, FAILED, TIMED OUT or STOPPED, with the exit code the ledger recorded. */
function report(runtime, say, end, maxRunMinutes, watching) {
    switch (end.kind) {
        case 'stopped':
            say(`its launching shell ended (${endedText(watching)}): killed its process tree`);
            runtime.out.stdout(`STOPPED killed, recorded as exit ${STOPPED_EXIT}`);
            return EXIT.failed;
        case 'timedOut':
            say(`timed out after ${minutesText(maxRunMinutes)}: killed its process tree`);
            runtime.out.stdout(`TIMED OUT killed, recorded as exit ${TIMED_OUT_EXIT}`);
            return EXIT.failed;
        case 'signal':
            runtime.out.stdout(`FAILED stopped by ${end.signal}, recorded as exit ${exitCodeOf(end)}`);
            return EXIT.failed;
        case 'exited':
            runtime.out.stdout(end.code === 0 ? 'DONE exit 0' : `FAILED exit ${end.code}`);
            return end.code === 0 ? EXIT.ok : EXIT.failed;
    }
}
/**
 * The lock of the step that started this one, from `$TEAMRIG_HOST_LOCK`, while that step still holds it; undefined when
 * the variable is unset or names no live lock (a leftover in a shell), which is said, since the step then waits as usual.
 */
async function parentLockOf(runtime, lock, say) {
    const token = runtime.env[ENV.hostLock]?.trim();
    if (token === undefined || token === '') {
        return undefined;
    }
    const held = await lock.heldWith(token);
    if (held === undefined) {
        say(`$${ENV.hostLock} names no live host lock: taking the lock as usual`);
    }
    return held;
}
/**
 * The step's session: `--session`, else `$TEAMRIG_SESSION`, else the parent step's (a git hook's checks under
 * `queue -- git commit` or a merge's push), else the session this Claude Code tab is bound to, so a hook
 * that wraps its checks in `queue` needs no session of its own.
 */
async function sessionOf(args, runtime, kit, roster, parent) {
    const named = args.flags.get('session') ?? envSession(runtime);
    if (named !== undefined) {
        return sessionIdOf(roster, sessionRef('--session', named));
    }
    const found = parent?.session ?? (await markedSessionOf(runtime, kit, roster, runtime.env[ENV.claudeSession]?.trim() ?? null));
    if (found === undefined) {
        throw new UsageError(`--session (or $${ENV.session}) is required outside a tab bound to a session`);
    }
    return found;
}
/**
 * A step started by a step that holds the host lock runs at once under that lock: it is part of its parent, whose
 * cutoff check and ledger record cover it, and waiting for the lock would wait on its own parent. `parent` is its
 * holder as `holderText` writes it.
 */
async function runUnderParent(runtime, say, parent, step) {
    const { what, words, maxRunMinutes, watching } = step;
    say(`running: ${what} under the host lock of ${parent} (killed after ${minutesText(maxRunMinutes)})`);
    const end = await runtime.steps.run({ command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: runtime.env, timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop });
    return report(runtime, say, end, maxRunMinutes, watching);
}
/**
 * True, having said so and printed DONE, when these checks already passed on this clean tree, so a push declined after
 * a long wait for the lock goes at once the next time: even from the queue cutoff on, since it runs nothing.
 */
async function reusedPass(runtime, say, prePush, zone) {
    if (prePush.before.kind !== 'clean') {
        return false;
    }
    const pass = await passOf(runtime.files, prePush.before, prePush.command, runtime.clock.now());
    if (pass === undefined) {
        return false;
    }
    say(`${pass.what} passed on this tree (${pass.commit.slice(0, 7)}) at ${zone.minute(new Date(pass.passedAt))}: not run again`);
    runtime.out.stdout('DONE exit 0');
    return true;
}
/** The tree a pass is recorded for: clean before and after the checks, and the same; undefined otherwise. */
function passedTree(before, after) {
    return before.kind === 'clean' && after.kind === 'clean' && after.tree === before.tree ? after : undefined;
}
/** Why checks that passed got no pass recorded. */
function noPassText(before, after) {
    if (before.kind === 'none' || after.kind === 'none') {
        return 'this folder has no git commit to record it for';
    }
    return before.kind === 'changed' || after.kind === 'changed' ? 'the tree has uncommitted changes' : 'the tree changed while they ran';
}
/**
 * After a pre-push hook's checks: records their pass when they passed on a tree that stayed clean and the same, then
 * declines the push when they waited for the lock past PRE_PUSH_MAX_WAIT_MS, as its connection may have closed by now;
 * the next push of the tree reuses the pass.
 */
async function afterPrePush(runtime, prePush, what, code, waitedMs) {
    if (code !== EXIT.ok) {
        return code;
    }
    const after = runtime.trees.checked(runtime.cwd);
    const passed = passedTree(prePush.before, after);
    if (passed !== undefined) {
        await recordPass(runtime.files, passed, prePush.command, what, runtime.clock.now());
    }
    if (waitedMs <= PRE_PUSH_MAX_WAIT_MS) {
        return code;
    }
    const next = passed === undefined ? `no pass was recorded, as ${noPassText(prePush.before, after)}: commit, then push again` : 'push again: it reuses this pass';
    throw new RefusedError(`push declined: its checks waited ${minutesText(Math.round(waitedMs / MINUTE_MS))} for the host lock, long enough for its connection to close; ${next}`);
}
/**
 * `teamrig queue --what <label> -- <command ...>`: runs one queued step (a build, a test run, a database script)
 * under the host lock, so the host's queued steps run one at a time. Refused from `delivery.schedule.queueCutoffUtc`
 * to midnight UTC, also when the wait for the lock ran past it, and once its line for the lock has not moved for
 * `delivery.queue.waitMinutes`. The step is killed with every process it started after `maxRunMinutes`
 * (`--max-minutes`), and its start and end go to the delivery ledger, with when it began to wait and, sampled
 * every `memorySampleSeconds`, the most its process tree held and the least free memory the host had. Its processes
 * get `$TEAMRIG_HOST_LOCK`, so a `queue` among them (a git hook's checks) runs at once under this lock. Every step
 * waits in its turn until the host's free memory leaves `memoryFloorMb` besides the MB held for it and for the small
 * steps sharing the host (`hostLockOf`'s memory gate): its need learned from its past runs or declared with
 * `--memory-mb` (`needOf`), at least `heavyReserveMb` for a step that takes the lock. With `--small` (a spec run, a
 * lint) the step shares the host with other small steps instead, holding its need or `smallReserveMb`; a step without
 * it waits for them to end. A small step is killed after `smallMaxRunMinutes` instead, and its `--max-minutes` goes no
 * higher. Once the shell that started it ends (Claude Code's
 * reaper ends a Bash tool's shell alone), it stops waiting for the lock, or kills its step and records exit 129, and
 * frees the lock. With `--pre-push` (a git pre-push hook's checks) it reuses their fresh pass on a clean tree, records
 * one when they pass, and declines a push whose checks waited past PRE_PUSH_MAX_WAIT_MS for the lock (push-pass.ts).
 * Exit 0 when the command passed, 1 when it failed, was killed or was stopped, 2 refused.
 */
export async function queue(args, runtime) {
    const words = commandWordsOf(args);
    const what = requiredFlag(args.flags, 'what');
    const request = requestOf(args, words, what);
    const declaredMb = declaredMbOf(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { delivery } = config;
    const zone = teamZone(config, runtime);
    const say = logLineOf(runtime, zone);
    const small = args.switches.has('small');
    const maxRunMinutes = maxRunMinutesOf(args, delivery.queue, small);
    const places = deliveryPlaces(delivery, kit.paths);
    const lock = hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom, zone);
    const parent = await parentLockOf(runtime, lock, say);
    const session = await sessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), parent);
    const watching = await watchStarters(runtime, say);
    try {
        const step = { what, words, maxRunMinutes, watching };
        const prePush = args.switches.has('pre-push') ? { command: commandLine(words, runtime.platform), before: runtime.trees.checked(runtime.cwd) } : undefined;
        if (prePush !== undefined && (await reusedPass(runtime, say, prePush, zone))) {
            return EXIT.ok;
        }
        if (parent !== undefined) {
            const code = await runUnderParent(runtime, say, holderText({ kind: 'held', info: parent }, zone), step);
            return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, 0);
        }
        refuseAfterCutoff(runtime, delivery.schedule.queueCutoffUtc, zone);
        // The register is read only for a step that queues: a nested step or one refused at once records nothing.
        const register = new JsonlEventLog(runtime.files, kit.paths.events);
        const owner = { session, ...(await withTaskPriority(request, async (id) => (await register.read()).state.tasks.get(id))) };
        const waits = new WaitLog(runtime.clock, runtime.memory.freeMb());
        const need = await needOf(runtime, places.ledger, { session, what, kind: request.kind, small, ...(declaredMb === undefined ? {} : { declaredMb }) }, delivery.queue);
        const waiting = small ? 'waiting to share the host' : 'waiting for the host lock';
        const taking = await unlessStopped(watching.stop, lock.acquire(session, `heavy: ${what}`, delivery.queue.waitMinutes * MINUTE_MS, delivery.wait.pollSeconds * 1_000, (holder, ahead) => {
            const text = `${waiting}: ${waitText(holder, ahead, zone)}`;
            waits.tell({ cause: causeOfLockWait(holder), text });
            say(text);
        }, need, watching.stop));
        if (taking === undefined) {
            await recordRefusal(runtime, places.ledger, waits, { ...owner, what, outcome: 'stopped', reason: `its launching shell ended (${endedText(watching)}) while it waited` });
            return stoppedWhileWaiting(runtime, say, watching);
        }
        if (taking.kind === 'busy') {
            return await refuseWaited(runtime, places.ledger, waits, { ...owner, what, outcome: 'timedOut', reason: busyText(taking.holder, zone) });
        }
        if (taking.kind === 'withdrawn') {
            return await refuseWaited(runtime, places.ledger, waits, { ...owner, what, outcome: 'withdrawn', reason: `withdrawn from the host lock's line (teamrig withdraw): ${what} did not run` });
        }
        const waited = waits.end();
        const waitedMs = runtime.clock.now() - waited.queuedAt;
        try {
            const cutoff = queueCutoffReason(runtime.clock.now(), delivery.schedule.queueCutoffUtc, zone);
            if (cutoff !== undefined) {
                return await refuseWaited(runtime, places.ledger, waits, { ...owner, what, outcome: 'refused', reason: cutoff });
            }
            const sharing = sharingText(need.reserveMb, taking);
            if (sharing !== undefined) {
                say(sharing);
            }
            say(`running: ${what} (killed after ${minutesText(maxRunMinutes)})`);
            const run = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: underLock(runtime.env, taking.lock), timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop };
            const mark = { ...owner, what, ...waited, ...(taking.sharing === undefined ? {} : { shared: true }), request: run };
            const end = await runRecorded(runtime, { places, delivery }, mark);
            const code = report(runtime, say, end, maxRunMinutes, watching);
            return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, waitedMs);
        }
        finally {
            await lock.release(taking.lock);
        }
    }
    finally {
        watching.close();
    }
}
