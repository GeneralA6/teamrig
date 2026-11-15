import { errorMessage } from "../core/guards.js";
import { deadRunsOf, diedEndOf, diedText } from "../delivery/detached-runs.js";
import { appendRecord, parseLedger } from "../delivery/ledger.js";
import { detachedDirOf } from "../delivery/places.js";
import { teamZone } from "./kit.js";
import { postUrgentLine } from "./urgent-line.js";
/**
 * Appends the end record of a dead run's step, unless the ledger has one: a run that died after its own end record,
 * before it removed its run record, keeps its real exit. Returns the problem when the ledger cannot be read or written.
 */
async function closeDiedStep(runtime, step) {
    try {
        const ended = parseLedger((await runtime.files.read(step.ledger)) ?? '').some((entry) => entry.type === 'heavy' && entry.id === step.start.id && entry.endedAt !== null);
        if (!ended) {
            await appendRecord(runtime.files, step.ledger, diedEndOf(step.start, new Date(runtime.clock.now()).toISOString()));
        }
        return undefined;
    }
    catch (error) {
        return errorMessage(error);
    }
}
/**
 * Tells each of this team's detached queue runs that died with no end of its own (T2742: a run whose process ended
 * while it waited for the host lock never reported, and its session waited on it for hours): a DIED line in its log and
 * an urgent line, which wakes its session. A run is told once: only the sweep whose removal of its record succeeds
 * tells it, and the run itself removes its record before its own end line, so of two sweeps and the run one reports.
 * Never throws: a folder that cannot be read or a line that cannot be posted is a problem returned, the run still
 * claimed, so a refusing inbox gets no line at every check. A run that died while its step ran also has that step's
 * ledger record closed (T2942): its own end never came, and a start record left open counts as a step running for ever.
 */
export async function sweepDeadDetachedRuns(runtime, kit, config) {
    const told = [];
    const problems = [];
    let dead;
    try {
        dead = await deadRunsOf({ files: runtime.files, alive: (pid) => runtime.sessionProcesses.alive(pid) }, detachedDirOf(config.delivery, kit.paths), kit.paths.team);
    }
    catch (error) {
        return { told, problems: [`the detached runs were not read: ${errorMessage(error)}`] };
    }
    const zone = teamZone(config, runtime);
    for (const { path, record } of dead) {
        let claimed = false;
        try {
            claimed = await runtime.files.remove(path);
            if (!claimed) {
                continue;
            }
            const text = diedText(record);
            await runtime.files.append(record.log, `${zone.second(new Date(runtime.clock.now()))} DIED ${text}\n`);
            const problem = await postUrgentLine(runtime, kit, config, { to: record.session, from: record.session, text });
            told.push(record.id);
            if (problem !== undefined) {
                problems.push(`${record.session} was not told that queue ${record.id} died: ${problem}`);
            }
        }
        catch (error) {
            problems.push(`queue ${record.id}'s death was not told: ${errorMessage(error)}`);
        }
        if (claimed && record.step !== undefined) {
            const problem = await closeDiedStep(runtime, record.step);
            if (problem !== undefined) {
                problems.push(`queue ${record.id}'s step was not closed in the ledger: ${problem}`);
            }
        }
    }
    return { told, problems };
}
