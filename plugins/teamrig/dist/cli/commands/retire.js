import { writeConfigWithBackup } from "../../config/load.js";
import { KIT_NAME } from "../../core/home.js";
import { FileLock } from "../../core/lock.js";
import { SecretScanner } from "../../core/secrets.js";
import { HiringLog } from "../../hiring/log.js";
import { activeHires } from "../../hiring/record.js";
import { SessionAskStore } from "../../core/session-asks.js";
import { planRetire } from "../../hiring/retire.js";
import { postLine } from "../../inbox/inbox.js";
import { ACTIVE_STATUSES } from "../../register/model.js";
import { RefreshStore } from "../../refresh/store.js";
import { onePositional } from "../args.js";
import { callerOf } from "../inputs.js";
import { checkedNextConfig, configFileJson, openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * `retire`: a lead over a session takes it off the team once its work is done or handed over: the lead, or a
 * sub-lead the session is under, who hands its tasks only within its group (T509); or a hired session
 * retires itself under `hiring.policy` automatic, once its tasks are closed. Without --yes it only shows the
 * retire; with it, its open tasks go to the heir (who gets one inbox line), the old config is kept in the
 * backups folder, the session's keys leave the config, then the retire is logged in the hire log. Its
 * tasks, inbox and records stay where they are, readable by its id.
 */
/** The backup name of a config before `retire` changed it. */
export const RETIRE_BACKUP_NAME = 'config.retire';
/** The ids of the open tasks the session owns, oldest first. */
async function openTasksOf(register, id) {
    const { state } = await register.snapshot();
    return [...state.tasks.values()].filter((task) => task.owner === id && ACTIVE_STATUSES.includes(task.status)).map((task) => task.id);
}
/** The request the command line makes, with what the team's files hold for the session. */
async function requestOf(args, runtime, kit, roster, register, by) {
    const { flags } = args;
    const id = sessionIdOf(roster, onePositional(args, 'id'));
    const to = flags.get('to');
    const noHandover = flags.get('no-handover');
    const reason = flags.get('reason');
    const handovers = new RefreshStore(runtime.files, kit.paths);
    return {
        id,
        ...(to === undefined ? {} : { heir: sessionIdOf(roster, to) }),
        ...(noHandover === undefined ? {} : { noHandover }),
        ...(reason === undefined ? {} : { reason }),
        openTasks: await openTasksOf(register, id),
        handoverPath: handovers.handoverPath(id),
        hasHandover: (await handovers.handover(id)) !== undefined,
        by,
        now: runtime.clock.now(),
    };
}
/** One line on what the retire does. */
function describeRetire(plan, roster) {
    const { retire, handOver, hired, regrouped } = plan;
    const tasks = handOver.length === 0 ? '' : `; its open task(s) ${handOver.join(', ')} go to ${retire.heir ?? ''}`;
    const members = regrouped.members.length === 0 ? '' : `; the session(s) it led, ${regrouped.members.join(', ')}, are now led by ${regrouped.to}`;
    const handover = retire.handover === undefined ? `no handover: ${retire.noHandover ?? ''}` : `handover ${retire.handover}`;
    const member = hired ? 'hired' : 'set up with the team';
    return `${retire.session} (name ${roster.nameOf(retire.session) ?? retire.session}, ${member}): ${retire.reason}${tasks}${members}; ${handover}`;
}
/** Hands the open tasks to the heir and tells it in one inbox line; a line that cannot be posted is named, never thrown. */
async function handOver(runtime, kit, register, plan, secrets) {
    const { retire, handOver: tasks } = plan;
    const heir = retire.heir;
    if (heir === undefined || tasks.length === 0) {
        return;
    }
    const where = retire.handover === undefined ? 'it left no handover' : `its handover: ${retire.handover}`;
    for (const task of tasks) {
        const verdict = await register.update(retire.by, task, { owner: heir }, `${retire.session} retired; ${where}`);
        if (!verdict.ok) {
            throw new RefusedError(`${task} was not handed to ${heir}, so nothing else was written: ${verdict.error}`);
        }
    }
    const text = `${tasks.join(', ')} ${tasks.length === 1 ? 'is' : 'are'} yours: ${retire.session} retired; ${where}`;
    const { inboxes } = inboxDepsOf(runtime, kit.paths);
    const problem = await postLine(inboxes, secrets, { to: heir, from: retire.by, text, now: new Date(runtime.clock.now()) });
    runtime.out.stderr(problem === undefined ? `NOTE ${heir} has an inbox line: ${text}` : `WARN ${heir} was not told of ${tasks.join(', ')}: ${problem}`);
}
/** `retire <id> [--to <heir>] [--no-handover "<why>"] [--reason "<why>"] [--yes]`. */
export async function retire(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const by = sessionIdOf(roster, caller);
    const register = teamRegister(runtime, kit.paths, config);
    const { files, clock, sleep, pid } = runtime;
    const { load } = kit;
    const log = new HiringLog(files, kit.paths.hires);
    const mutex = new FileLock(kit.paths.hiresLock, config.lock, { files, clock, sleep, pid });
    return mutex.run(async () => {
        const request = await requestOf(args, runtime, kit, roster, register, by);
        const { records, skipped } = await log.read();
        const plan = planRetire(await configFileJson(runtime, load.path), config, activeHires(records), request);
        if (!plan.ok) {
            throw new RefusedError(plan.problem);
        }
        checkedNextConfig(plan.value.config);
        const what = describeRetire(plan.value, roster);
        if (skipped > 0) {
            runtime.out.stdout(`NOTE ${skipped} damaged or newer line(s) in ${log.path} were skipped, so a hired session may show as set up with the team`);
        }
        if (!args.switches.has('yes')) {
            runtime.out.stdout(`PREVIEW retire ${what}; nothing written (add --yes to write)`);
            return EXIT.ok;
        }
        await handOver(runtime, kit, register, plan.value, new SecretScanner(config.register.secretPatterns));
        const backup = await writeConfigWithBackup(files, { configPath: load.path, backupsDir: kit.paths.backups, backupName: RETIRE_BACKUP_NAME }, plan.value.config, clock);
        // The config first: a retire logged for a session still on the team would leave it out of the active hires.
        await log.append(plan.value.retire);
        const session = plan.value.retire.session;
        // A due ask to retire is done with, and would ask the session again if it were hired back.
        await new SessionAskStore(files, kit.paths.retireAsks).clear(session);
        runtime.out.stdout(`RETIRED ${what}; the old config is at ${backup}`);
        runtime.out.stdout(`NEXT its records stay readable by its id (${KIT_NAME} list --session ${session} --all)${by === session ? '; finish this turn and close the tab' : '; close its tab if it is open'}`);
        return EXIT.ok;
    });
}
