import { takeWhenClear } from "../delivery/clearance.js";
import { underLock } from "../delivery/host-lock.js";
import { appendDeploy } from "../delivery/ledger.js";
import { recordQueuedStep } from "../delivery/recorded-step.js";
import { askChecks, shownLine } from "./checks.js";
import { hookEndText, hookExitCode, succeeded } from "./hooks.js";
import { short } from "./pending.js";
import { chosenRepo, scheduleReadiness, shownBy } from "./run.js";
/**
 * `teamrig deploy --targets <a,b> --what "<why>" -- <command>`: a deploy that pulls nothing, such as the restart that
 * makes some of a repository's targets read a rotated secret on the same image. It goes by the rules of that
 * repository's deploy: the queue cutoff and the reset blackout refuse it, deploy freezes on the targets it names hold it,
 * and the repository's checks hold or refuse it, asked again under the host lock. Then it runs the command, one queued
 * step in the ledger, and records a deploy of those targets, so `teamrig stable-periods` counts only them as disturbed.
 */
const MINUTE_MS = 60_000;
/** The checks' and the command's environment: this process's, with the deploy's `TEAMRIG_*` variables. */
function redeployEnv(setup, ports, request, repo) {
    return {
        ...ports.env,
        TEAMRIG_TEAM: setup.team,
        TEAMRIG_SESSION: request.session,
        TEAMRIG_VERB: 'redeploy',
        TEAMRIG_REPO: repo.name,
        TEAMRIG_DEPLOY_TARGETS: request.targets.join(','),
    };
}
/** Why the request may not deploy what it names: no targets, or one not in the repository's deploy targets. */
function targetsProblem(repo, targets) {
    const known = repo.deploy.targets;
    const listed = `delivery.repos.${repo.name}.deploy.targets (${known.length === 0 ? 'none set' : known.join(', ')})`;
    if (targets.length === 0) {
        return `name the targets the command restarts, from ${listed}`;
    }
    const unknown = targets.filter((target) => !known.includes(target));
    if (unknown.length === 0) {
        return undefined;
    }
    return `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in ${listed}: a deploy names only targets the deploy freezes and stable periods know`;
}
/** Under the host lock: runs the command with the lock's token in its environment, each line shown redacted. */
async function runCommand(setup, ports, request, env) {
    const show = shownBy(ports);
    let lastLine;
    const end = await ports.hooks.run({
        argv: request.argv,
        cwd: request.dir,
        env,
        timeoutMs: setup.delivery.queue.maxRunMinutes * MINUTE_MS,
        onLine: (line) => {
            const shown = show(line).trim();
            if (shown !== '') {
                lastLine = shown;
            }
        },
    });
    return { end, lastLine };
}
/** Deploys some of a repository's targets with a command that pulls nothing (see the module comment). */
export async function redeployTargets(setup, ports, request) {
    const chosen = chosenRepo(setup, ports, request);
    if (chosen.kind === 'refused') {
        return chosen;
    }
    const { repo } = chosen;
    const problem = targetsProblem(repo, request.targets);
    if (problem !== undefined) {
        return { kind: 'refused', reason: problem };
    }
    const early = ports.git.sha(repo.main, 'HEAD');
    if (early === undefined) {
        return { kind: 'refused', reason: `${repo.main} (delivery.repos.${repo.name}.mainCheckout) names no commit at HEAD, so the deploy could not record what it ran on` };
    }
    const targets = request.targets.join(', ');
    const env = redeployEnv(setup, ports, request, repo);
    const readiness = async (phase) => {
        const stopped = await scheduleReadiness(setup, ports, request.targets);
        if (stopped !== undefined) {
            return stopped;
        }
        const answer = await askChecks(repo.deploy.checks, phase, { hooks: ports.hooks, scanner: ports.scanner, cwd: repo.main, env, timeoutSeconds: setup.delivery.checkTimeoutSeconds });
        return answer.readiness;
    };
    const { wait } = setup.delivery;
    const queuedAt = ports.clock.now();
    const clearance = await takeWhenClear(readiness, ports, {
        session: request.session,
        purpose: `deploy ${targets} of ${repo.name}`,
        maxWaitMs: wait.maxMinutes * MINUTE_MS,
        pollMs: wait.pollSeconds * 1_000,
        zone: setup.zone,
        onWait: (reason) => ports.say(`waiting: ${reason}`),
    });
    if (clearance.kind !== 'taken') {
        return { kind: 'refused', reason: clearance.reason };
    }
    try {
        const startedAt = new Date(ports.clock.now()).toISOString();
        const head = ports.git.sha(repo.main, 'HEAD') ?? early;
        ports.say(`clear; deploying ${targets} of ${repo.name}: ${request.argv.join(' ')}`);
        const what = `deploy ${request.targets.join(',')} of ${repo.name}`;
        const run = await recordQueuedStep(ports, setup.places.ledger, { session: request.session, what, queuedAt }, () => runCommand(setup, ports, request, underLock(env, clearance.lock)), (ran) => hookExitCode(ran.end));
        const why = shownLine(ports.scanner, request.why);
        const said = run.lastLine === undefined ? '' : `: ${run.lastLine}`;
        if (run.end.kind === 'notStarted') {
            return { kind: 'failed', reason: `the command ${hookEndText(run.end)}, so nothing was deployed` };
        }
        const ok = succeeded(run.end);
        await appendDeploy(ports.files, setup.places, {
            type: 'deploy',
            kind: 'deploy',
            session: request.session,
            repo: repo.name,
            range: `at ${short(head)}`,
            what: `deploy ${targets}`,
            note: ok ? `${why}; ${run.lastLine ?? 'ran'}` : `${why}; the command ${hookEndText(run.end)}${said}`,
            startedAt,
            rolledAt: new Date(ports.clock.now()).toISOString(),
            targets: request.targets,
        });
        if (ok) {
            return { kind: 'done', summary: `deployed ${targets} of ${repo.name}${said}` };
        }
        return { kind: 'failed', reason: `the command ${hookEndText(run.end)}${said}, so ${targets} may be partly restarted; its owners fix forward or roll back` };
    }
    finally {
        await ports.lock.release(clearance.lock);
    }
}
