import { join } from 'node:path';
import { dispatchedEnvOf } from "../../core/child-env.js";
import { errorMessage, isRecord, numberField, stringField } from "../../core/guards.js";
import { claimParked, hasParked, park, parkedDirOf } from "../../delivery/parked.js";
import { parseArgs, UsageError } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
import { QUEUE_FLAGS, QUEUE_SWITCHES } from "./queue-args.js";
/** The dispatcher's record in the detached folder: its pid, written only by the dispatcher that holds the folder. */
export const DISPATCHER_RECORD = 'dispatcher.json';
/** The dispatcher's own log in the detached folder; each step's lines go to that step's log. */
export const DISPATCHER_LOG = 'dispatcher.log';
/** How often the dispatcher looks for newly parked steps: a parked step joins the host lock's line within this. */
export const DISPATCH_POLL_MS = 2_000;
/** The switch that runs `queue` as the dispatcher, the words a dispatcher's command line holds. */
export const DISPATCH_SWITCH = 'dispatch';
const DISPATCH_WORDS = `queue --${DISPATCH_SWITCH}`;
function parseDispatcher(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const [pid, startedAt] = [numberField(value, 'pid'), stringField(value, 'startedAt')];
    return pid === undefined || startedAt === undefined || !Number.isSafeInteger(pid) ? undefined : { pid, startedAt };
}
/**
 * Whether the dispatcher a record names still runs: its process is alive and, when the system shows its command
 * line, that line is a dispatcher's, so a later process that took a dead dispatcher's pid is not taken for it.
 */
async function dispatcherRuns(runtime, record) {
    if (!runtime.sessionProcesses.alive(record.pid)) {
        return false;
    }
    const info = await runtime.sessionProcesses.describe(record.pid);
    return info === undefined || info.commandLine === '' || info.commandLine.includes(DISPATCH_WORDS);
}
/** Whether the dispatcher of the detached folder `dir` runs. A torn or missing record is none. */
async function liveDispatcher(runtime, dir) {
    const text = await runtime.files.read(join(dir, DISPATCHER_RECORD));
    const record = text === undefined ? undefined : parseDispatcher(text);
    return record !== undefined && (await dispatcherRuns(runtime, record));
}
/**
 * Starts the dispatcher of the detached folder `dir` unless one runs, hidden and outliving this command. It gets this
 * command's whole environment in memory, never on disk: the credentials `delivery.passEnv` lets a step have come
 * from it. Two parkers that both start one are settled by the dispatcher's record (`holdFolder`): one runs on.
 */
export async function ensureDispatcher(runtime, dir) {
    if (await liveDispatcher(runtime, dir)) {
        return undefined;
    }
    const started = await runtime.processes.startHidden({
        command: runtime.self.node,
        args: [runtime.self.script, 'queue', `--${DISPATCH_SWITCH}`],
        cwd: runtime.cwd,
        env: runtime.env,
        log: join(dir, DISPATCHER_LOG),
    });
    if (started.kind === 'started') {
        return undefined;
    }
    return started.kind === 'missing' ? `${runtime.self.node} was not found` : started.error;
}
/**
 * Parks `step` and makes sure a dispatcher will run it (T4093), so its wait for its turn holds a file, not a process.
 * Parking comes first and the look for a dispatcher after, while a dispatcher about to end gives up its record before
 * its last look for parked steps: one of the two always sees the other, so no step is parked with no dispatcher.
 * When none can start, the step is taken back and the reason thrown, so nothing is left that no one runs.
 */
export async function parkStep(runtime, dir, step) {
    const path = await park(runtime.files, parkedDirOf(dir), step);
    const problem = await ensureDispatcher(runtime, dir);
    if (problem !== undefined) {
        await runtime.files.remove(path);
        throw new RefusedError(`${step.what} did not start detached: ${problem}`);
    }
}
/** Takes the detached folder for this dispatcher: true when its record is now this process's. */
async function holdFolder(runtime, dir) {
    const path = join(dir, DISPATCHER_RECORD);
    const record = `${JSON.stringify({ pid: runtime.pid, startedAt: new Date(runtime.clock.now()).toISOString() })}\n`;
    if (await runtime.files.createExclusive(path, record)) {
        return true;
    }
    if (await liveDispatcher(runtime, dir)) {
        return false;
    }
    // A dead dispatcher's record: of two that find it, only the one whose removal takes it may write its own.
    return (await runtime.files.remove(path)) && (await runtime.files.createExclusive(path, record));
}
/** An output that appends each line to `log`, in order; `flushed` waits for the lines written so far. */
function logOutput(runtime, log) {
    let tail = Promise.resolve();
    const write = (line) => {
        tail = tail.then(() => runtime.files.append(log, `${line}\n`)).catch(() => undefined);
    };
    return { stdout: write, stderr: write, flushed: () => tail };
}
/**
 * The runtime a parked step runs in: its own folder, the dispatcher's environment under its own parked variables
 * (`dispatchedEnvOf`), its lines and its command's output in its log.
 */
function stepRuntimeOf(runtime, step, out) {
    return {
        ...runtime,
        cwd: step.cwd,
        env: dispatchedEnvOf(runtime.env, step.env),
        out,
        steps: { run: (request) => runtime.steps.run({ ...request, log: request.log ?? step.log }) },
    };
}
/** Runs one parked step as its detached run would, every end of it in its log, never failing the dispatcher. */
async function runParked(runtime, step, run) {
    const out = logOutput(runtime, step.log);
    try {
        const [command, ...rest] = step.argv;
        const args = parseArgs([command ?? '', ...rest], { queue: QUEUE_FLAGS }, { queue: QUEUE_SWITCHES }, {}, new Set(['queue']));
        if (args.command !== 'queue' || !args.flags.has('detached-run')) {
            throw new UsageError(`a parked step runs only a detached queue run: ${step.argv.join(' ')}`);
        }
        await run(args, stepRuntimeOf(runtime, step, out));
    }
    catch (error) {
        out.stdout(error instanceof RefusedError ? `REFUSED ${error.message}` : `FAILED ${errorMessage(error)}`);
    }
    await out.flushed();
}
/**
 * `queue --dispatch`: the host's one dispatcher for the detached folder `dir` (T4093). It takes each parked step and
 * runs it in this process, at once and side by side, so every step waits for its turn here and none holds a node
 * process of its own; a step's tickets and run record carry this pid, so they live and die with the dispatcher, and
 * a sweep tells a dead dispatcher's steps as died (detached-sweep.ts). It ends once nothing is parked or running.
 * A second dispatcher finds the first's record and ends at once.
 */
export async function dispatch(runtime, dir, run) {
    if (!(await holdFolder(runtime, dir))) {
        runtime.out.stdout(`a dispatcher already runs for ${dir}`);
        return EXIT.ok;
    }
    runtime.out.stdout(`dispatcher pid ${runtime.pid} for ${dir}`);
    const running = new Set();
    const told = new Set();
    for (;;) {
        const claimed = await claimParked(runtime.files, parkedDirOf(dir));
        for (const path of claimed.unreadable.filter((name) => !told.has(name))) {
            told.add(path);
            runtime.out.stdout(`left ${path}: it is no parked step`);
        }
        for (const step of claimed.steps) {
            runtime.out.stdout(`running parked step ${step.id}: ${step.what}`);
            const done = runParked(runtime, step, run).finally(() => running.delete(done));
            running.add(done);
        }
        if (claimed.steps.length === 0 && running.size === 0) {
            // The record goes before the last look: a step parked after that look finds no dispatcher and starts one.
            await runtime.files.remove(join(dir, DISPATCHER_RECORD));
            if (!(await hasParked(runtime.files, parkedDirOf(dir), told)) || !(await holdFolder(runtime, dir))) {
                runtime.out.stdout('dispatcher ends: nothing parked or running');
                return EXIT.ok;
            }
            continue;
        }
        await runtime.sleep(DISPATCH_POLL_MS);
    }
}
