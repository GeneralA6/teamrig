import { resolve } from 'node:path';
import { ENV, KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { issueRef } from "../../github/map.js";
import { countsLine, parseMigrateRows, planMigration, previewMarkdown, replacedRefNote } from "../../github/migrate.js";
import { RegisterPolicy } from "../../register/policy.js";
import { onePositional } from "../args.js";
import { callerOf } from "../inputs.js";
import { hostOf } from "../issue-hosts.js";
import { sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
import { reportRotation } from "./register.js";
import { openTeam } from "./register-team.js";
/** The ids of live tasks with no row a run names on its NO ROW line; the rest are counted. */
export const SHOWN_UNROWED = 20;
/**
 * `issue migrate <file> [--out <preview.md>] [--yes]` (T2550): moves the caller's team's tasks to GitHub issues from a
 * file of JSON-lines rows (github/migrate.ts), each a task's public wording or the reason it stays local. Without
 * `--yes` it writes nothing but the `--out` preview, a page with every issue in full for a reviewer. `--yes` opens
 * each planned issue through the issue host port (issues/host.ts; on GitHub with the token saved for the repository's
 * owner, else, when none is saved, the gh login; a saved token the store could not read stops the run), then points
 * the task's ref at it as `update <id> --ref` by the caller would, so the sync adds no second
 * task for it; a ref that is no issue gives way, named in the update's note. It stops at the first failure, and a rerun skips each task already holding its issue. Exit 1 when
 * gh failed, 2 when the register refused a ref, else 0.
 */
export async function issueMigrate(args, runtime) {
    const path = resolve(runtime.cwd, onePositional(args, 'file'));
    const write = args.switches.has('yes');
    const caller = callerOf(args.flags, runtime.env);
    const team = await openTeam(runtime, write ? 'write' : 'read');
    const by = sessionIdOf(team.roster, caller);
    const policy = new RegisterPolicy(team.config, team.above);
    const notOnTeam = policy.checkCaller(by);
    if (notOnTeam !== undefined) {
        throw new RefusedError(notOnTeam);
    }
    const say = (line) => runtime.out.stdout(line);
    if (write && githubOff(runtime.env)) {
        say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; no issue was opened`);
        return EXIT.ok;
    }
    const scanner = new SecretScanner(team.config.register.secretPatterns);
    const rows = await rowsAt(runtime, path, scanner);
    const { snapshot, elsewhere } = await team.register.snapshotWithElsewhere();
    const judge = (task, ref) => {
        const verdict = policy.update(task, by, { ref }, refNote(task.ref), snapshot.state, elsewhere);
        return verdict.ok ? undefined : verdict.error;
    };
    const plan = planMigration(rows, snapshot.state.tasks, team.config.github.repos, judge);
    const out = args.flags.get('out');
    if (out !== undefined) {
        const at = resolve(runtime.cwd, out);
        await runtime.files.write(at, previewMarkdown(plan));
        say(`PREVIEW FILE ${at}`);
    }
    planLines(plan).forEach(say);
    if (!write) {
        say(`PREVIEW nothing was written; ${KIT_NAME} issue migrate <file> --yes opens the issues and sets each task's ref`);
        return EXIT.ok;
    }
    return openIssues(runtime, team, by, plan.creates, scanner);
}
/** The rows of the file at `path`; refused when it is missing or a row is bad. */
async function rowsAt(runtime, path, scanner) {
    const text = await runtime.files.read(path);
    if (text === undefined) {
        throw new RefusedError(`no row file ${path}`);
    }
    const parsed = parseMigrateRows(text, scanner);
    if (!parsed.ok) {
        throw new RefusedError(`${path}: ${parsed.error}`);
    }
    return parsed.value;
}
/** The note of a ref update: the ref it replaces, when there is one. */
function refNote(old) {
    return old === null ? undefined : replacedRefNote(old);
}
/** Each ref an issue replaces, each skipped row with why, the live tasks no row names, and the counts. */
function planLines(plan) {
    const more = plan.unrowed.length - SHOWN_UNROWED;
    const unrowed = plan.unrowed.slice(0, SHOWN_UNROWED).join(' ');
    return [
        ...plan.creates.flatMap((create) => (create.replaces === null ? [] : [`REPLACES ${create.id}: its ref ${create.replaces} gives way to its issue`])),
        ...plan.skipped.map((skip) => `SKIPPED ${skip.id}: ${skip.reason}`),
        ...(plan.unrowed.length === 0 ? [] : [`NO ROW ${plan.unrowed.length} live task(s) no row names: ${unrowed}${more > 0 ? ` and ${more} more` : ''}`]),
        countsLine(plan),
    ];
}
/** Opens each issue and sets its task's ref, in order, stopping at the first failure. */
async function openIssues(runtime, team, by, creates, scanner) {
    const say = (line) => runtime.out.stdout(line);
    // planMigration plans issues only for github.repos, GitHub's list, so every one is GitHub's.
    const host = hostOf('github', runtime, scanner);
    const told = new Set();
    let opened = 0;
    const stopped = (id) => `STOPPED at ${id} after opening ${opened} issue(s); fix the cause and rerun: tasks holding their issue are skipped`;
    for (const create of creates) {
        const reach = await host.reach(create.draft.repo, 'open');
        if (reach.kind === 'unreachable') {
            say(`FAILED ${create.id}: ${reach.reason}`);
            say(stopped(create.id));
            return EXIT.failed;
        }
        if (!told.has(reach.scope)) {
            told.add(reach.scope);
            say(`ACCESS ${reach.access}`);
        }
        const end = await host.open(create.draft);
        if (end.kind === 'failed') {
            say(`FAILED ${create.id}: ${end.reason}`);
            say(stopped(create.id));
            return EXIT.failed;
        }
        const ref = issueRef(end.target.repo, end.target.number);
        const verdict = await team.register.update(by, create.id, { ref }, refNote(create.replaces));
        if (!verdict.ok) {
            say(`REFUSED ${create.id}: ${verdict.error}; its issue ${ref} was opened: set it with ${KIT_NAME} update ${create.id} --ref ${ref}`);
            say(stopped(create.id));
            return EXIT.refused;
        }
        reportRotation(runtime, verdict.value.rotation, team.paths);
        opened += 1;
        say(`OPENED ${create.id} ${ref}`);
    }
    say(`DONE opened ${opened} issue(s) and set each task's ref`);
    return EXIT.ok;
}
