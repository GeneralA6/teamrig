import { QUEUE_TTL_MARGIN_MINUTES } from "../../config/defaults.js";
import { busyText, holderText, isHeavyShare, underLock, waitText } from "../../delivery/host-lock.js";
import { parseLedger } from "../../delivery/ledger.js";
import { teamRequestsOf } from "../../delivery/line-requests.js";
import { pipelineFrozenRefusal } from "../../delivery/pipeline-freezes.js";
import { formatRunRecord, RUN_RECORD_FORMAT, runRecordPathOf } from "../../delivery/detached-runs.js";
import { deliveryPlaces, detachedDirOf, detachedLogOf } from "../../delivery/places.js";
import { passOf, PRE_PUSH_MAX_WAIT_MS, recordPass } from "../../delivery/push-pass.js";
import { isStepKind, kindOfCommand, processRequest, STEP_KINDS, taskOfLabel } from "../../delivery/process-request.js";
import { recordRefusal, runRecorded } from "../../delivery/recorded-step.js";
import { stepNeedOf } from "../../delivery/step-need.js";
import { causeOfLockWait, WaitLog } from "../../delivery/wait-log.js";
import { queueCutoffReason, minutesText } from "../../delivery/schedule.js";
import { endedText, startedByGit } from "../../delivery/starter-watch.js";
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT } from "../../delivery/steps.js";
import { errorMessage } from "../../core/guards.js";
import { parkedEnvOf, withoutCredentials } from "../../core/child-env.js";
import { PARKED_FORMAT } from "../../delivery/parked.js";
import { DISPATCH_SWITCH, dispatch, parkStep } from "./queue-dispatch.js";
import { ENV } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { TASK_ID } from "../../register/model.js";
import { commandLine } from "../../test-run/shell.js";
import { requiredFlag, UsageError } from "../args.js";
import { hostLockOf, logLineOf, teamAdmissionOf } from "../delivery-ports.js";
import { sessionRef, shellWordsOf } from "../inputs.js";
import { openTeamKit, reloadTeamConfig, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { parentLockOf } from "../parent-lock.js";
import { EXIT, RefusedError } from "../runtime.js";
import { rerunAdvice, stoppedWhileWaiting, unlessStopped, watchStarters } from "../stoppable.js";
import { shipKindRefusal, shipTaskOfWords, shipToolOfWords, shipToolPinOf, shipToolStartRefusal } from "../ship-role-check.js";
import { postUrgentLine } from "../urgent-line.js";
import { envSession, markedSessionOf } from "./hook-input.js";
import { inboxDepsOf } from "./inbox.js";
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
/**
 * `request`, given the task its ship tool ships (`shipped`) when neither `--task` nor its label names one (T3286): a
 * ship line names none, so its ticket would take the default class and no priority. Read only for a step that queues.
 */
function withShipTask(request, shipped) {
    const task = request.task ?? shipped();
    return task === request.task ? request : processRequest(request.kind, task);
}
/** Why the step may not start now (the queue cutoff, a pipeline freeze on its kind, a moved ship tool), or undefined when it may. */
async function startRefusal(runtime, gate) {
    const now = runtime.clock.now();
    return queueCutoffReason(now, gate.cutoffUtc, gate.zone) ?? pipelineFrozenRefusal(await runtime.files.read(gate.pipelineFreezes), gate.pipelineFreezes, now, [gate.kind], gate.zone) ?? (await gate.shipTool());
}
/**
 * The start check of a step that runs a configured ship tool (T3223): pinned as this run of queue begins, the --detach
 * call, its detached run and a hand-over's run each, so a tool whose checkout is not main's current code is refused
 * before it waits, and one whose checkout moved while it waited is refused at its start. Nothing is taken from the
 * arguments, so no flag can loosen it; a step that runs no ship tool has no check. A run whose kind does not fit it,
 * a merge that would not take the ship slot or a run without --merge that would (T3414), is refused before it waits.
 */
function shipToolCheckOf(runtime, kit, config, words, kind) {
    const tool = shipToolOfWords(kit, config, words, runtime.cwd);
    if (tool === undefined) {
        return () => Promise.resolve(undefined);
    }
    const misfit = shipKindRefusal(kit, config, words, runtime.cwd, kind);
    if (misfit !== undefined) {
        return () => Promise.resolve(misfit);
    }
    const pin = shipToolPinOf(runtime.mergeGit, kit, config, tool);
    // A stale tool's refusal comes from the gate (`refuseUnstartable`), so a detached run refused before it waits still tells its session.
    return 'refused' in pin ? () => Promise.resolve(pin.refused) : () => shipToolStartRefusal(runtime.mergeGit, kit, config, pin, runtime.sleep);
}
async function refuseUnstartable(runtime, gate) {
    const reason = await startRefusal(runtime, gate);
    if (reason !== undefined) {
        throw new RefusedError(reason);
    }
}
/** Refuses a step that waited and did not run, after its refusal record (`recordRefusal`), with the reason it records. */
async function refuseWaited(runtime, ledger, waits, mark) {
    throw new RefusedError(await recordRefusal(runtime, ledger, waits, mark));
}
/**
 * `--exclusive`: the step takes the whole host (the lock file), waiting for every step sharing it, where a heavy step
 * would share the host under `pipeline` admission. A small step shares by definition, so the two flags refuse together.
 */
function exclusiveOf(args, small) {
    const exclusive = args.switches.has('exclusive');
    if (exclusive && small) {
        throw new UsageError('--exclusive takes the whole host and --small shares it: give one of them');
    }
    return exclusive;
}
/**
 * What the step asks of the host (`stepNeedOf`): its need learned from its own past runs in the ledger, or its
 * `--memory-mb`, else the config's default, so a step known to need more waits for that much room.
 */
async function needOf(runtime, ledger, ask, config) {
    return stepNeedOf(parseLedger((await runtime.files.read(ledger)) ?? ''), ask, config);
}
/**
 * The line a step holding `reserveMb` prints when it shares the host: the other steps of its own kind (small or heavy)
 * sharing it, then those of the other kind when any do.
 */
function sharingText(reserveMb, taking) {
    const { sharing } = taking;
    if (sharing === undefined) {
        return undefined;
    }
    const heavy = sharing.others.filter(isHeavyShare).length;
    const small = sharing.others.length - heavy;
    const counts = sharing.heavy
        ? [stepCount(heavy, 'other heavy'), ...(small === 0 ? [] : [stepCount(small, 'small')])]
        : [stepCount(small, 'other small'), ...(heavy === 0 ? [] : [stepCount(heavy, 'heavy')])];
    const free = sharing.freeMb === undefined ? '' : `${sharing.freeMb} MB free, `;
    return `sharing the host${sharing.heavy ? ' as a heavy step' : ''}: ${reserveMb} MB held for it (${free}${counts.join(', ')})`;
}
/** `<count> <kind> step`, or `steps`. */
function stepCount(count, kind) {
    return `${count} ${kind} step${count === 1 ? '' : 's'}`;
}
/** How the run ended, with the exit code the ledger recorded, said first when it was killed. */
function endedOf(say, end, maxRunMinutes, watching) {
    switch (end.kind) {
        case 'stopped':
            say(`its launching shell ended (${endedText(watching)}): killed its process tree`);
            return { code: EXIT.failed, last: `STOPPED killed, recorded as exit ${STOPPED_EXIT}; ${rerunAdvice('partway')}` };
        case 'timedOut':
            say(`timed out after ${minutesText(maxRunMinutes)}: killed its process tree`);
            return { code: EXIT.failed, last: `TIMED OUT killed, recorded as exit ${TIMED_OUT_EXIT}` };
        case 'signal':
            return { code: EXIT.failed, last: `FAILED stopped by ${end.signal}, recorded as exit ${exitCodeOf(end)}` };
        case 'exited':
            return end.code === 0 ? { code: EXIT.ok, last: 'DONE exit 0' } : { code: EXIT.failed, last: `FAILED exit ${end.code}` };
    }
}
/** Prints the run's last line and tells its reporting (a detached run's session); its exit code. */
async function report(runtime, say, end, step) {
    const ended = endedOf(say, end, step.maxRunMinutes, step.watching);
    runtime.out.stdout(ended.last);
    await step.reporting.ended(ended.last);
    return ended.code;
}
const UNREPORTED = { started: async () => undefined, opened: async () => undefined, ended: async () => undefined };
/** Writes the detached run's record; a record that cannot be written is said in the log, never failing the step. */
async function keepRunRecord(runtime, say, path, record) {
    try {
        await runtime.files.write(path, formatRunRecord(record));
    }
    catch (error) {
        say(`its run record was not written, so a death of this run goes untold: ${errorMessage(error)}`);
    }
}
/**
 * A detached run's session hears in its inbox when its step starts, and, with a wake, when it ends or is refused, since
 * no shell waits for its last line; a line that cannot be posted is said in the log, never failing the step. The run
 * keeps its record (detached-runs.ts) from now until its end line, so a sweep tells its session if it dies before
 * then, and with its step's start record once that is in the ledger, so the sweep closes it too (T2942); it logs its
 * pid, so a death can be traced to what ended it.
 */
async function detachedReporting(runtime, kit, config, say, run) {
    const { id, session, what, log, record: recordPath } = run;
    const record = { v: RUN_RECORD_FORMAT, id, team: kit.paths.team, session, what, log, pid: runtime.pid, startedAt: new Date(runtime.clock.now()).toISOString() };
    say(`detached run ${id}: pid ${runtime.pid}`);
    await keepRunRecord(runtime, say, recordPath, record);
    let running = record;
    return {
        started: async () => {
            running = { ...record, runningAt: new Date(runtime.clock.now()).toISOString() };
            await keepRunRecord(runtime, say, recordPath, running);
            const text = `queue ${id} started: ${what}; log ${log}`;
            let problem;
            try {
                problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), { to: session, from: session, text, now: new Date(runtime.clock.now()) });
            }
            catch (error) {
                problem = errorMessage(error);
            }
            if (problem !== undefined) {
                say(`its start line was not posted to ${session}'s inbox: ${problem}`);
            }
        },
        opened: async (step) => {
            await keepRunRecord(runtime, say, recordPath, { ...running, step });
        },
        ended: async (last) => {
            // Removed before the line: of this run and a sweep, only the one whose removal takes the record reports a death.
            try {
                await runtime.files.remove(recordPath);
            }
            catch (error) {
                say(`its run record was not removed: ${errorMessage(error)}`);
            }
            const problem = await postUrgentLine(runtime, kit, config, { to: session, from: session, text: `queue ${id} ended: ${what}: ${last}; log ${log}` });
            if (problem !== undefined) {
                say(`its end line was not posted to ${session}'s inbox: ${problem}`);
            }
        },
    };
}
/** A detached run has no shell to watch: `--detach`'s returned at once, so nothing stops it but its time limit. */
function unwatched() {
    return { starters: [], stop: new AbortController().signal, ended: () => undefined, tabAlive: () => false, close: () => undefined };
}
/** The id `--detach` gives its run: the UTC second it started and the caller's process id, so two starts differ. */
export function detachedIdOf(now, pid) {
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return `${stamp}-${pid}`;
}
const DETACHED_ID = /^\d{8}-\d{6}-\d+$/;
/** `--detached-run`: the id of the run `--detach` started; set only by it. */
function detachedRunIdOf(args) {
    const id = args.flags.get('detached-run');
    if (id !== undefined && !DETACHED_ID.test(id)) {
        throw new UsageError('--detached-run is set by --detach: run the step with --detach');
    }
    return id;
}
/**
 * `--arrived-at`: the epoch ms a step handed over (`handOver`) first joined the host lock's line, so its detached run
 * keeps that place; set only by the hand-over, with `--detached-run`, and never past now.
 */
function arrivedAtOf(args, now) {
    const text = args.flags.get('arrived-at');
    if (text === undefined) {
        return undefined;
    }
    if (!args.flags.has('detached-run')) {
        throw new UsageError('--arrived-at is set by queue when it hands a waiting step over to a detached run: never give it by hand');
    }
    const at = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(at) || at <= 0 || at > now) {
        throw new UsageError(`--arrived-at takes the epoch milliseconds the step joined the line, at most now: ${text}`);
    }
    return at;
}
/**
 * `--detach`: checks a step needs its result at once refuse. A pre-push hook's checks decide its push; a step under a
 * live host lock is part of its parent step, which waits for it, and `--detached-run` is the run `--detach` starts.
 */
function refuseDetachUsage(args) {
    if (args.switches.has('pre-push')) {
        throw new UsageError('--detach returns before the step runs and --pre-push decides a push by its result: give one of them');
    }
    if (args.flags.has('detached-run')) {
        throw new UsageError('--detached-run is set by --detach: give only --detach');
    }
}
/**
 * The detached run's arguments: this command's flags and switches less `--detach`, its session resolved, its id added,
 * and for a hand-over the time its step first joined the line.
 */
function detachedArgsOf(args, words, session, id, arrivedAt) {
    const flags = [...args.flags].filter(([name]) => name !== 'session').flatMap(([name, value]) => [`--${name}`, value]);
    const switches = [...args.switches].filter((name) => name !== 'detach').map((name) => `--${name}`);
    const arrival = arrivedAt === undefined ? [] : ['--arrived-at', String(arrivedAt)];
    return ['queue', '--detached-run', id, '--session', session, ...arrival, ...flags, ...switches, '--', ...words];
}
/**
 * Parks this step for the host's dispatcher (`queue --dispatch`, T4093), which runs it as a `queue --detached-run`
 * that outlives this command and its shell, its output and the queue's lines in its log, then prints QUEUED: a step
 * longer than a Bash tool's wait no longer holds one open, nor dies with the shell Claude Code's reaper ends, and
 * while it waits for its turn it holds a file, not a node process. Only allow-listed variables go on disk
 * (`parkedEnvOf`), so no secret does: the rest, credentials too, the step gets from the dispatcher's environment.
 */
async function startDetached(runtime, places, args, run) {
    const { id, session, what, words, arrivedAt } = run;
    await parkStep(runtime, places.dir, {
        v: PARKED_FORMAT,
        id,
        team: places.team,
        session,
        what,
        log: places.log,
        argv: detachedArgsOf(args, words, session, id, arrivedAt),
        cwd: runtime.cwd,
        env: parkedEnvOf(runtime.env),
        parkedAt: new Date(runtime.clock.now()).toISOString(),
    });
    runtime.out.stdout(`QUEUED ${id}: ${what} runs detached; log ${places.log}; ${session}'s inbox gets a line when it starts and when it ends`);
    return EXIT.ok;
}
/** The detached places of run `id` of the team `kit`. */
function detachedPlacesOf(kit, config, id) {
    return { team: kit.paths.team, dir: detachedDirOf(config.delivery, kit.paths), log: detachedLogOf(config.delivery, kit.paths, id) };
}
/**
 * `queue --dispatch`: runs as the host's dispatcher of the team's detached folder; `queue --detach` starts it. It
 * takes no other flag or command: what it runs comes from the parked steps.
 */
async function dispatchParked(args, runtime) {
    if (args.flags.size > 0 || args.switches.size > 1 || args.rest.length > 0 || args.positionals.length > 0) {
        throw new UsageError('--dispatch is started by --detach and runs the parked steps: give it alone');
    }
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    return dispatch(runtime, detachedDirOf(config.delivery, kit.paths), queue);
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
    const { what, words, maxRunMinutes, watching, env } = step;
    say(`running: ${what} under the host lock of ${parent} (killed after ${minutesText(maxRunMinutes)})`);
    await step.reporting.started();
    const end = await runtime.steps.run({ command: commandLine(words, runtime.platform), cwd: runtime.cwd, env, timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop });
    return report(runtime, say, end, step);
}
/**
 * Whether a step whose launching shell ended while it waited for the lock goes on as a detached run (T2304): only while
 * the tab's Claude Code runs, so its low-memory reaper or the Bash tool's time limit ended the shell alone and the
 * session still wants the result; never a git hook's step (its git command took the shell's end as the hook's) or a
 * pre-push hook's checks, whose push is gone.
 */
function handsOver(watching, prePush) {
    return !prePush && watching.tabAlive() && !startedByGit(watching.starters);
}
/**
 * Hands a step whose launching shell ended over to a detached run that joins the line at the step's first arrival,
 * then posts the session an urgent line: its Bash tool saw the step die, and running it again would queue it twice.
 */
async function handOver(runtime, context, run) {
    const { kit, config, say, args, ended } = context;
    const { session, what } = run;
    const id = detachedIdOf(runtime.clock.now(), runtime.pid);
    const places = detachedPlacesOf(kit, config, id);
    const { log } = places;
    try {
        await startDetached(runtime, places, args, { ...run, id });
    }
    catch (error) {
        return { kind: 'failed', why: errorMessage(error) };
    }
    say(`its launching shell ended (${ended}) while it waited: detached run ${id} keeps its place in line`);
    const text = `queue ${id} kept ${what}'s place in line: its launching shell ended (${ended}) while it waited, so it runs on detached; do not run it again; log ${log}; teamrig withdraw --session ${session} --what "${what}" stops it`;
    const problem = await postUrgentLine(runtime, kit, config, { to: session, from: session, text });
    if (problem !== undefined) {
        say(`its hand-over line was not posted to ${session}'s inbox: ${problem}`);
    }
    return { kind: 'handed' };
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
 * `--memory-mb` (`needOf`), at least `heavyReserveMb` for a heavy step. With `--small` (a spec run, a lint) the step
 * shares the host with other small steps, holding its need or `smallReserveMb`, in a line of its own under `pipeline`
 * (never behind a heavy step) and at most `maxSmallParallel` at once; a heavy step shares it too under
 * `pipeline` admission, at most `maxHeavyParallel` at once and joining another only while `heavyIdleCpuPct` of the
 * host's CPU is idle (`hostLockOf`'s CPU gate), and takes the lock, waiting for every share to end, under
 * `serial` or with `--exclusive`. A small step is killed after `smallMaxRunMinutes` instead, and its `--max-minutes`
 * goes no higher. Once the shell that started it ends (Claude Code's
 * reaper ends a Bash tool's shell alone), it kills a running step, records exit 129 and frees the lock; a waiting step
 * goes on as a detached run that keeps its place in line while the tab's Claude Code runs (`handsOver`), else stops. With `--pre-push` (a git pre-push hook's checks) it reuses their fresh pass on a clean tree, records
 * one when they pass, and declines a push whose checks waited past PRE_PUSH_MAX_WAIT_MS for the lock (push-pass.ts).
 * Exit 0 when the command passed, 1 when it failed, was killed or was stopped, 2 refused.
 */
export async function queue(args, runtime) {
    if (args.switches.has(DISPATCH_SWITCH)) {
        return dispatchParked(args, runtime);
    }
    const words = shellWordsOf(args, runtime.platform);
    const what = requiredFlag(args.flags, 'what');
    const request = requestOf(args, words, what);
    const declaredMb = declaredMbOf(args);
    const detach = args.switches.has('detach');
    if (detach) {
        refuseDetachUsage(args);
    }
    const detachedId = detachedRunIdOf(args);
    const firstArrival = arrivedAtOf(args, runtime.clock.now());
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { delivery } = config;
    const zone = teamZone(config, runtime);
    const say = logLineOf(runtime, zone);
    const small = args.switches.has('small');
    const exclusive = exclusiveOf(args, small);
    const maxRunMinutes = maxRunMinutesOf(args, delivery.queue, small);
    const places = deliveryPlaces(delivery, kit.paths);
    const requests = teamRequestsOf(runtime.files, kit.paths, config.focus);
    const lock = hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom, teamAdmissionOf(config, () => reloadTeamConfig(runtime, kit)), zone, requests);
    const parent = await parentLockOf(runtime, lock, say);
    const session = await sessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), parent);
    const gate = { cutoffUtc: delivery.schedule.queueCutoffUtc, pipelineFreezes: places.pipelineFreezes, kind: request.kind, zone, shipTool: shipToolCheckOf(runtime, kit, config, words, request.kind) };
    if (detach) {
        if (parent !== undefined) {
            throw new UsageError('--detach under a live host lock: a step a queued step starts runs at once under its lock, and that step waits for its result; run it without --detach');
        }
        await refuseUnstartable(runtime, gate);
        const id = detachedIdOf(runtime.clock.now(), runtime.pid);
        return await startDetached(runtime, detachedPlacesOf(kit, config, id), args, { id, session, what, words });
    }
    const reporting = detachedId === undefined
        ? UNREPORTED
        : await detachedReporting(runtime, kit, config, say, { id: detachedId, session, what, log: detachedLogOf(delivery, kit.paths, detachedId), record: runRecordPathOf(detachedDirOf(delivery, kit.paths), detachedId) });
    const watching = detachedId === undefined ? await watchStarters(runtime, say) : unwatched();
    try {
        const step = { what, words, maxRunMinutes, watching, reporting, env: withoutCredentials(runtime.env, delivery.passEnv) };
        const prePush = args.switches.has('pre-push') ? { command: commandLine(words, runtime.platform), before: runtime.trees.checked(runtime.cwd) } : undefined;
        if (prePush !== undefined && (await reusedPass(runtime, say, prePush, zone))) {
            return EXIT.ok;
        }
        if (parent !== undefined) {
            const code = await runUnderParent(runtime, say, holderText({ kind: 'held', info: parent }, zone), step);
            return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, 0);
        }
        await refuseUnstartable(runtime, gate);
        // The register and the front are read only for a step that queues: a nested step or one refused at once records nothing.
        const shipped = withShipTask(request, () => shipTaskOfWords(runtime.mergeGit, kit, config, words, runtime.cwd));
        const line = await requests.current(shipped);
        // Only the ticket carries the class for now: the ledger's start and refusal records keep the fields their readers take.
        const owner = { session, ...processRequest(line.kind, line.task, line.priority) };
        const waits = new WaitLog(runtime.clock, runtime.memory.freeMb());
        const need = await needOf(runtime, places.ledger, { session, what, kind: request.kind, small, ...(declaredMb === undefined ? {} : { declaredMb }) }, delivery.queue);
        const waiting = small ? 'waiting to share the host' : 'waiting for the host lock';
        const arrivedAt = firstArrival ?? runtime.clock.now();
        const taking = await unlessStopped(watching.stop, lock.acquire(session, `heavy: ${what}`, delivery.queue.waitMinutes * MINUTE_MS, delivery.wait.pollSeconds * 1_000, (holder, ahead) => {
            const text = `${waiting}: ${waitText(holder, ahead, zone)}`;
            waits.tell({ cause: causeOfLockWait(holder), text });
            say(text);
        }, { need, request: line, exclusive, arrivedAt }, watching.stop));
        if (taking === undefined) {
            const ended = endedText(watching);
            const handed = handsOver(watching, prePush !== undefined) ? await handOver(runtime, { kit, config, say, args, ended }, { session, what, words, arrivedAt }) : undefined;
            if (handed?.kind === 'handed') {
                return EXIT.ok;
            }
            const notHanded = handed === undefined ? '' : `; its detached run did not start: ${handed.why}`;
            await recordRefusal(runtime, places.ledger, waits, { ...owner, what, outcome: 'stopped', reason: `its launching shell ended (${ended}) while it waited${notHanded}` });
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
            const refusal = await startRefusal(runtime, gate);
            if (refusal !== undefined) {
                return await refuseWaited(runtime, places.ledger, waits, { ...owner, what, outcome: 'refused', reason: refusal });
            }
            const sharing = sharingText(need.reserveMb, taking);
            if (sharing !== undefined) {
                say(sharing);
            }
            say(`running: ${what} (killed after ${minutesText(maxRunMinutes)})`);
            await reporting.started();
            const run = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: underLock(step.env, taking.lock), timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop };
            const mark = { ...owner, what, ...waited, ...(taking.sharing === undefined || taking.sharing.heavy ? {} : { shared: true }), request: run };
            const end = await runRecorded(runtime, { places, delivery, opened: (start) => reporting.opened({ ledger: places.ledger, start }) }, mark);
            const code = await report(runtime, say, end, step);
            return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, waitedMs);
        }
        finally {
            await lock.release(taking.lock);
        }
    }
    catch (error) {
        // A step refused, or a queue that broke, ends with no last line of its own; a detached run's session hears why.
        await reporting.ended(error instanceof RefusedError ? `REFUSED ${error.message}` : `FAILED ${errorMessage(error)}`);
        throw error;
    }
    finally {
        watching.close();
    }
}
