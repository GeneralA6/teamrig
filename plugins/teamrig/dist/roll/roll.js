import { claimText, coveringClaims, readClaims } from "../coordinator/claims.js";
import { takeWhenClear } from "../coordinator/clearance.js";
import { underLock } from "../coordinator/host-lock.js";
import { appendDeploy } from "../coordinator/ledger.js";
import { NOT_STARTED_EXIT, recordHeavy } from "../coordinator/recorded-step.js";
import { heavyCutoffReason, resetBlackoutReason } from "../coordinator/schedule.js";
import { samePath } from "../core/paths.js";
import { askGates, shownLine } from "./gates.js";
import { hookEndText, hookExitCode, succeeded } from "./hooks.js";
import { plural, readPending, rollRepos, short } from "./pending.js";
/**
 * `teamrig roll`: brings what was pushed to a repository's default branch to the running system, one roll on the host
 * at a time. It reads what is pending (the main checkout's `HEAD..origin/<default branch>`), refuses what it must not
 * pull (a main checkout off its default branch, with tracked changes or commits origin lacks, a held dependency
 * change), waits out the heavy cutoff's refusal, quiet claims on the roll's targets and the team's gates, takes the
 * host lock, asks again, then pulls fast-forward to the sha it checked, runs the afterPull hooks and the roll command,
 * all one heavy step in the ledger, and records the deploy. Nothing pending is done with nothing run.
 */
const MINUTE_MS = 60_000;
/** The line a roll command prints when nothing needed rolling: the pull stays, and no deploy is recorded. */
export const NO_ROLL_LINE = 'no-roll';
function runExitCode(run) {
    switch (run.kind) {
        case 'notPulled':
            return NOT_STARTED_EXIT;
        case 'afterPullFailed':
        case 'ran':
            return hookExitCode(run.end);
    }
}
/** The repository to roll: the one named, else the one the folder is in, else the only one with a roll block. */
function chosenRepo(setup, ports, request) {
    const repos = Object.entries(setup.coordinator.repos);
    const rolled = rollRepos(setup.coordinator, (path) => setup.inTeam(path));
    const names = rolled.length === 0 ? 'none has a roll block' : `with a roll block: ${rolled.map((repo) => repo.name).join(', ')}`;
    if (request.repo !== undefined) {
        const named = rolled.find((repo) => repo.name === request.repo);
        if (named !== undefined) {
            return { kind: 'chosen', repo: named };
        }
        const listed = repos.some(([name]) => name === request.repo);
        return { kind: 'refused', reason: listed ? `coordinator.repos.${request.repo} has no roll block, so there is nothing to roll it with (${names})` : `${request.repo} is not in coordinator.repos (${names})` };
    }
    const here = ports.git.checkoutOf(request.dir);
    const folderMain = here === undefined ? undefined : (here.mainCheckout ?? here.top);
    const inFolder = folderMain === undefined ? undefined : rolled.find((repo) => samePath(repo.main, folderMain, ports.platform));
    const only = rolled.length === 1 ? rolled[0] : undefined;
    const chosen = inFolder ?? only;
    if (chosen !== undefined) {
        return { kind: 'chosen', repo: chosen };
    }
    return { kind: 'refused', reason: rolled.length === 0 ? 'no repository in coordinator.repos has a roll block' : `name the repository to roll with --repo (${names})` };
}
/** Every hook's environment: this process's, with the roll's `TEAMRIG_*` variables and `extra`. */
function hookEnv(setup, ports, request, repo, pending, extra = {}) {
    return {
        ...ports.env,
        TEAMRIG_TEAM: setup.team,
        TEAMRIG_SESSION: request.session,
        TEAMRIG_VERB: 'roll',
        TEAMRIG_REPO: repo.name,
        TEAMRIG_PENDING_RANGE: `${pending.head}..${pending.target}`,
        ...extra,
    };
}
/**
 * Whether the roll may start: the heavy cutoff and the reset blackout refuse it, a quiet claim on its targets and a
 * gate that does not pass hold it. Under the lock the pending range is read again, so the gates judge what is pulled;
 * a range with nothing left, refused or unreadable is not the gates' to judge, so the check passes and the roll ends
 * under the lock.
 */
function readinessOf(setup, ports, request, repo, view) {
    const { schedule } = setup.coordinator;
    const { targets, gates } = repo.roll;
    return async (phase) => {
        const now = ports.clock.now();
        const hours = schedule.resetBlackoutHours;
        const refusal = heavyCutoffReason(now, schedule.heavyCutoffUtc) ?? (hours === undefined ? undefined : resetBlackoutReason(now, await ports.nextReset(now), hours));
        if (refusal !== undefined) {
            return { kind: 'refuse', reason: refusal };
        }
        if (targets.length > 0) {
            const read = await readClaims(ports.files, setup.places.claims);
            if (read.kind === 'unreadable') {
                return { kind: 'wait', reason: `the quiet claims in ${setup.places.claims} are unreadable (${read.reason})` };
            }
            const covering = coveringClaims(read.claims, targets, now);
            if (covering.length > 0) {
                return { kind: 'wait', reason: covering.map(claimText).join('; ') };
            }
        }
        if (phase === 'locked') {
            view.read = await readPending(ports.git, repo);
            view.tag = undefined;
            if (view.read.kind !== 'pending') {
                return { kind: 'go' };
            }
            view.range = view.read.pending;
        }
        const answer = await askGates(gates, phase, {
            hooks: ports.hooks,
            scanner: ports.scanner,
            cwd: repo.main,
            env: hookEnv(setup, ports, request, repo, view.range),
            timeoutSeconds: setup.coordinator.gateTimeoutSeconds,
        });
        if (phase === 'locked') {
            view.tag = answer.tag;
        }
        return answer.readiness;
    };
}
/**
 * Under the host lock `lock`: pulls fast-forward to the checked sha, then runs the afterPull hooks and the roll command,
 * each line shown redacted. They get the lock's token, so a `teamrig heavy` they start runs under this lock.
 */
async function pullAndRoll(setup, ports, request, repo, pending, tag, lock) {
    const pulled = ports.git.fastForward(repo.main, pending.target);
    if (!pulled.ok) {
        return { kind: 'notPulled', reason: pulled.reason };
    }
    ports.say(`pulled ${repo.main} to ${short(pending.target)}`);
    const env = underLock(hookEnv(setup, ports, request, repo, pending, { TEAMRIG_ROLL_TO: pending.target, ...(tag === undefined ? {} : { TEAMRIG_ROLL_TAG: tag }) }), lock);
    const timeoutMs = setup.coordinator.heavy.maxRunMinutes * MINUTE_MS;
    const show = (line) => {
        const shown = shownLine(ports.scanner, line);
        ports.say(`  ${shown}`);
        return shown;
    };
    for (const argv of repo.roll.afterPull) {
        ports.say(`afterPull: ${argv.join(' ')}`);
        const end = await ports.hooks.run({ argv, cwd: repo.main, env, timeoutMs, onLine: show });
        if (!succeeded(end)) {
            return { kind: 'afterPullFailed', argv, end };
        }
    }
    ports.say(`roll: ${repo.roll.command.join(' ')}`);
    let lastLine;
    let noRoll = false;
    const end = await ports.hooks.run({
        argv: repo.roll.command,
        cwd: repo.main,
        env,
        timeoutMs,
        onLine: (line) => {
            const shown = show(line);
            noRoll ||= line.trim() === NO_ROLL_LINE;
            if (shown.trim() !== '') {
                lastLine = shown.trim();
            }
        },
    });
    return { kind: 'ran', end, lastLine, noRoll };
}
/** What a pulled range ends as, and its deploy record when the roll command rolled something or failed trying. */
async function settle(setup, ports, request, repo, pending, tag, startedAt, run) {
    const { range, commits } = pending;
    const byHand = `a new roll finds nothing pending, so run \`${repo.roll.command.join(' ')}\` in ${repo.main} by hand once it is fixed`;
    switch (run.kind) {
        case 'notPulled':
            return { kind: 'failed', reason: `the pull of ${range} into ${repo.main} failed (${run.reason}): nothing pulled, nothing rolled; roll again` };
        case 'afterPullFailed':
            return { kind: 'failed', reason: `${range} pulled, but afterPull \`${run.argv.join(' ')}\` ${hookEndText(run.end)}, so nothing rolled; ${byHand}` };
        case 'ran':
            break;
    }
    const ok = succeeded(run.end);
    const said = run.lastLine === undefined || run.lastLine === NO_ROLL_LINE ? '' : `: ${run.lastLine}`;
    if (ok && run.noRoll) {
        return { kind: 'done', summary: `${range} pulled; nothing needed rolling${said}` };
    }
    const carried = plural(commits.length, 'commit');
    const what = `roll ${repo.roll.targets.length > 0 ? repo.roll.targets.join(', ') : repo.name}${tag === undefined ? '' : ` (${tag})`}`;
    await appendDeploy(ports.files, setup.places, {
        type: 'deploy',
        kind: 'deploy',
        session: request.session,
        repo: repo.name,
        range,
        what,
        note: ok ? `${carried}; ${run.lastLine ?? 'rolled'}` : `${carried}; the roll command ${hookEndText(run.end)}${said}`,
        startedAt,
        rolledAt: new Date(ports.clock.now()).toISOString(),
    });
    if (ok) {
        return { kind: 'done', summary: `${range} rolled${said}` };
    }
    return { kind: 'failed', reason: `${range} pulled, but the roll command ${hookEndText(run.end)}${said}; its owners fix forward or roll back, and ${byHand}` };
}
/** Rolls what was pushed to a repository's default branch (see the module comment). */
export async function rollRepo(setup, ports, request) {
    const chosen = chosenRepo(setup, ports, request);
    if (chosen.kind === 'refused') {
        return chosen;
    }
    const { repo } = chosen;
    const nothing = (head) => ({ kind: 'done', summary: `nothing to roll: the ${repo.name} main checkout is at its origin's default branch (${short(head)})` });
    const early = await readPending(ports.git, repo);
    if (early.kind === 'none') {
        return nothing(early.head);
    }
    if (early.kind !== 'pending') {
        return early;
    }
    ports.say(`${plural(early.pending.commits.length, 'commit')} pending in ${repo.name} (${early.pending.range})`);
    const view = { read: undefined, tag: undefined, range: early.pending };
    const { wait } = setup.coordinator;
    const clearance = await takeWhenClear(readinessOf(setup, ports, request, repo, view), ports, {
        session: request.session,
        purpose: `roll ${repo.name}`,
        maxWaitMs: wait.maxMinutes * MINUTE_MS,
        pollMs: wait.pollSeconds * 1_000,
        onWait: (reason) => ports.say(`waiting: ${reason}`),
    });
    if (clearance.kind !== 'taken') {
        return { kind: 'refused', reason: clearance.reason };
    }
    try {
        const latest = view.read ?? (await readPending(ports.git, repo));
        if (latest.kind === 'none') {
            return nothing(latest.head);
        }
        if (latest.kind !== 'pending') {
            return latest;
        }
        const { pending } = latest;
        const { tag } = view;
        const startedAt = new Date(ports.clock.now()).toISOString();
        ports.say(`clear; pulling ${plural(pending.commits.length, 'commit')} (${pending.range}) into ${repo.main}`);
        const run = await recordHeavy(ports, setup.places.ledger, { session: request.session, what: `roll ${repo.name} ${pending.range}` }, () => pullAndRoll(setup, ports, request, repo, pending, tag, clearance.lock), runExitCode);
        return await settle(setup, ports, request, repo, pending, tag, startedAt, run);
    }
    finally {
        await ports.lock.release(clearance.lock);
    }
}
