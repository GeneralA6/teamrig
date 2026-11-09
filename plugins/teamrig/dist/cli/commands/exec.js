import { resolve } from 'node:path';
import { roleHolderOf } from "../../config/roster.js";
import { formatAddress } from "../../core/address.js";
import { errorMessage } from "../../core/guards.js";
import { SecretScanner } from "../../core/secrets.js";
import { AuditChainError, AuditLog, nextRequestId, REQUEST_ID, } from "../../exec/audit.js";
import { resolveProgram } from "../../exec/binding.js";
import { nodeLaunchRefusal } from "../../exec/node-launch.js";
import { parseDraft } from "../../exec/request.js";
import { decideReview, RANDOM_NONCES, UnsignedReviews } from "../../exec/review.js";
import { baseEnvironment, environmentCredentials, Executor } from "../../exec/runner.js";
import { noPositionals, onePositional, requiredFlag, UsageError } from "../args.js";
import { postToHolder, sessionNameOn } from "../holder-team.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { fileLockOf } from "../file-locks.js";
/** Refuses an exec command on a node started with an option that can run code beside the pinned client (T1036). */
function refuseForeignLaunch(runtime) {
    const refusal = nodeLaunchRefusal(runtime.self.execArgv, runtime.env, runtime.platform);
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
}
async function openExec(runtime, access) {
    refuseForeignLaunch(runtime);
    const kit = await openTeamKit(runtime);
    return execTeamOf(runtime, kit, requireConfig(kit, runtime, access));
}
function execTeamOf(runtime, kit, config) {
    const { files, clock, platform } = runtime;
    const lock = fileLockOf(runtime, kit.paths.execAuditLock, config.lock);
    const execPath = config.exec.path.join(platform === 'win32' ? ';' : ':');
    return {
        kit,
        config,
        audit: new AuditLog(kit.paths.execAudit, files, lock, clock),
        execPath,
        search: { env: { PATH: execPath }, platform, probe: runtime.probe },
        scanner: new SecretScanner(config.register.secretPatterns),
    };
}
/** The caller as the log names it: the owner's marker (register.ownerSource) or a session's id, self-declared in phase 1 (spec §4). */
async function actorOf(args, runtime, team) {
    const caller = callerOf(args.flags, runtime.env);
    return caller === team.config.register.ownerSource ? caller : sessionIdOf(await rosterOf(runtime, team.kit, team.config), caller);
}
async function childExecOf(runtime, child, access) {
    refuseForeignLaunch(runtime);
    const kit = await openTeamKit(runtime);
    const own = { kit, config: requireConfig(kit, runtime, 'read') };
    const { tree, teams } = await loadTree(runtime);
    const target = teams.get(child);
    if (target === undefined) {
        throw new RefusedError(`no team ${child} with a config in this kit home`);
    }
    if (!tree.ancestorsOf(child).includes(kit.paths.team)) {
        throw new RefusedError(`team ${child} is not below team ${kit.paths.team}: --team names a team below yours`);
    }
    return { team: execTeamOf(runtime, target.kit, requireConfig(target.kit, runtime, access)), own };
}
/** The exec team `status` reads: the caller's own, or with `--team <child>` a team below it. */
async function readTeamOf(args, runtime) {
    const child = args.flags.get('team');
    return child === undefined ? openExec(runtime, 'read') : (await childExecOf(runtime, child, 'read')).team;
}
/**
 * The exec team a review goes to, and the reviewer as its log names them: the caller's own team (actorOf), or with
 * `--team <child>` a team below it, where the owner keeps its marker and a session of the caller's team is
 * `<team>/<id>`, the form the child's roles.securityReviewer names a reviewer above it by; decideReview refuses anyone else.
 */
async function reviewerTeamOf(args, runtime) {
    const child = args.flags.get('team');
    if (child === undefined) {
        const team = await openExec(runtime, 'write');
        return { team, reviewer: await actorOf(args, runtime, team) };
    }
    const { team, own } = await childExecOf(runtime, child, 'write');
    const caller = callerOf(args.flags, runtime.env);
    if (caller === team.config.register.ownerSource) {
        return { team, reviewer: caller };
    }
    return { team, reviewer: formatAddress({ team: own.kit.paths.team, id: sessionIdOf(await rosterOf(runtime, own.kit, own.config), caller) }) };
}
function brokenLog(file, line, reason) {
    return new RefusedError(`the exec audit log is broken at ${file} line ${line}: ${reason}; nothing more is written to it`);
}
/** Runs `step`, turning a broken audit log into a refusal. */
async function onSoundLog(step) {
    try {
        return await step();
    }
    catch (error) {
        if (error instanceof AuditChainError) {
            throw brokenLog(error.file, error.line, error.reason);
        }
        throw error;
    }
}
/** Appends the event `decide` picks under the log's lock, or refuses with its reason. */
async function appendOrRefuse(audit, decide) {
    const result = await onSoundLog(() => audit.append(decide));
    if (!result.ok) {
        throw new RefusedError(result.refusal);
    }
    return result.line;
}
function isEventOf(event, type) {
    return event.type === type;
}
/** The event of the line a command just appended; any other type than the one it appended is a bug. */
function appendedEvent(line, type) {
    const { event } = line;
    if (!isEventOf(event, type)) {
        throw new Error(`exec audit line ${line.seq} holds a ${event.type} event, not the ${type} just appended`);
    }
    return event;
}
async function stateOf(team) {
    const read = await team.audit.read();
    if (!read.ok) {
        throw brokenLog(team.kit.paths.execAudit, read.line, read.reason);
    }
    return read.state;
}
function requestIdOf(text) {
    if (!REQUEST_ID.test(text)) {
        throw new UsageError(`"${text}" is not a request id (R1, R2, ...)`);
    }
    return text;
}
async function requestFileJson(runtime, path) {
    const text = await runtime.files.read(path);
    if (text === undefined) {
        throw new RefusedError(`no request file ${path}`);
    }
    try {
        const raw = JSON.parse(text);
        return raw;
    }
    catch (error) {
        throw new RefusedError(`${path} is not JSON: ${errorMessage(error)}`);
    }
}
/** The file `argv[0]` starts, found on the exec PATH; a refusal names the folders searched. */
async function programOf(field, argv, team) {
    const [argv0 = ''] = argv;
    const program = await resolveProgram(argv0, team.search);
    if (program === undefined) {
        const folders = team.config.exec.path.length === 0 ? 'exec.path names no folder' : `exec.path: ${team.config.exec.path.join(', ')}`;
        throw new RefusedError(`${field}[0] "${argv0}" is not a file on the exec PATH (${folders})`);
    }
    return program;
}
/**
 * `exec request --file <request.json>`: checks a privileged command's request file (spec §5), resolves its programs on
 * the exec PATH and logs it as the next R<n>; nothing runs yet.
 */
export async function request(args, runtime) {
    noPositionals(args);
    const path = resolve(runtime.cwd, requiredFlag(args.flags, 'file'));
    const team = await openExec(runtime, 'write');
    const requester = await actorOf(args, runtime, team);
    const parsed = parseDraft(await requestFileJson(runtime, path), team.scanner);
    if (!parsed.ok) {
        throw new RefusedError(`${path}: ${parsed.problems.join('; ')}`);
    }
    const { draft } = parsed;
    const program = await programOf('argv', draft.argv, team);
    const dryRunProgram = draft.dryRunArgv === null ? null : await programOf('dryRunArgv', draft.dryRunArgv, team);
    const createdAt = new Date(runtime.clock.now()).toISOString();
    const line = await appendOrRefuse(team.audit, (state) => ({
        type: 'request',
        request: { ...draft, id: nextRequestId(state), requester, createdAt, program, dryRunProgram },
    }));
    const { request: stored } = appendedEvent(line, 'request');
    const next = stored.dryRunArgv === null ? `a reviewer reads its preview (teamrig exec status ${stored.id})` : `teamrig exec dry-run ${stored.id}`;
    runtime.out.stdout(`REQUESTED ${stored.id}: ${stored.kind} on ${stored.target} for ${stored.task}; next: ${next}`);
    await tellReviewer(runtime, team, stored);
    return EXIT.ok;
}
/**
 * Who reviews a new request first (spec §7): the security reviewer, of this team or of a team above it (T1143), or
 * the owner for security's own request or when none is set.
 */
function firstReviewerOf(config, team, requester) {
    const security = roleHolderOf(config.roles, 'securityReviewer', team);
    return security === undefined || (security.team === team && security.id === requester) ? { team, id: config.register.ownerSource } : security;
}
/**
 * Posts the first reviewer one inbox line for a logged request, on the reviewer's own team when it sits above this one,
 * where the line names the requester and the team to review on; a line that cannot be posted warns, as the request stands.
 */
async function tellReviewer(runtime, team, stored) {
    const own = team.kit.paths.team;
    const reviewer = firstReviewerOf(team.config, own, stored.requester);
    const crossing = reviewer.team !== own;
    const label = sessionNameOn(own, reviewer.team, reviewer.id);
    const text = `${stored.id} asks to run a ${stored.kind} on ${stored.target} for ${stored.task}: review it (teamrig exec status ${stored.id}${crossing ? ` --team ${own}` : ''})`;
    const problem = await postToHolder(runtime, team, reviewer, { from: stored.requester, text });
    runtime.out.stderr(problem === undefined ? `NOTE ${label} has an inbox line: ${text}` : `WARN ${stored.id} is logged, but ${label} was not told: ${problem}`);
}
function executorOf(team, runtime) {
    return new Executor({
        audit: team.audit,
        binding: { checkout: runtime.exec.checkout, search: team.search },
        spawner: runtime.exec.spawner,
        credentials: environmentCredentials(runtime.env, runtime.platform),
        verifier: new UnsignedReviews(),
        scanner: team.scanner,
        files: runtime.files,
        outDir: team.kit.paths.execOut,
        baseEnv: baseEnvironment(team.execPath, runtime.env, runtime.platform),
    });
}
/** How a process ended, in words. */
function endOf(outcome) {
    if (outcome.timedOut) {
        return 'timed out';
    }
    return outcome.exitCode === null ? 'ended with no exit code' : `exit ${outcome.exitCode}`;
}
function tailLines(tail) {
    return tail.split('\n').filter((line, index, lines) => line !== '' || index < lines.length - 1);
}
/** The outcome of a dry run or a run that started; a refusal throws. */
function startedOutcome(result) {
    if (!result.ok) {
        throw new RefusedError(result.refusal);
    }
    return result.outcome;
}
/** Prints a dry run's or a run's end and its output's tail; an unclean end fails. */
function printOutcome(runtime, head, outcome, next) {
    const clean = outcome.exitCode === 0 && !outcome.timedOut;
    const then = clean && next !== undefined ? `; next: ${next}` : '';
    runtime.out.stdout(`${head}: ${endOf(outcome)}; output ${outcome.outputFile} (SHA-256 ${outcome.outputSha256})${then}`);
    tailLines(outcome.tail).forEach((line) => runtime.out.stdout(`  ${line}`));
    return clean ? EXIT.ok : EXIT.failed;
}
/** `exec dry-run R<n>`: runs the request's read-only dry run with its read variables, and logs it for the reviewer (spec §6). */
export async function dryRun(args, runtime) {
    const id = requestIdOf(onePositional(args, 'id'));
    const team = await openExec(runtime, 'write');
    const outcome = startedOutcome(await onSoundLog(() => executorOf(team, runtime).dryRun(id)));
    return printOutcome(runtime, `DRY RUN ${id}`, outcome, `the reviewer reads it (teamrig exec status ${id}), then approves, refuses or escalates it`);
}
/** `exec run R<n>`: runs an approved request once (spec §8); the logged start burns the approval. */
export async function run(args, runtime) {
    const id = requestIdOf(onePositional(args, 'id'));
    const team = await openExec(runtime, 'write');
    const outcome = startedOutcome(await onSoundLog(() => executorOf(team, runtime).run(id)));
    const code = printOutcome(runtime, `RAN ${id}`, outcome, undefined);
    await announce(runtime, team, id, `RAN ${id}: ${endOf(outcome)}; output SHA-256 ${outcome.outputSha256}`);
    return code;
}
/**
 * Posts a review or a run to the security channel (spec §10), where security reconciles it against its own reviews,
 * so the line also names the team and the request's kind, target, task and requester. Only when exec.webhookEnv is
 * set; a line that cannot be posted warns, as the event stands logged and the command keeps its exit code.
 */
async function announce(runtime, team, id, head) {
    const variable = team.config.exec.webhookEnv;
    if (variable === undefined) {
        return;
    }
    const url = runtime.env[variable];
    if (url === undefined || url === '') {
        runtime.out.stderr(`WARN exec.webhookEnv names ${variable}, which is not set: nothing posted`);
        return;
    }
    try {
        const problem = await postProblem(runtime, team, url, id, head);
        if (problem !== undefined) {
            runtime.out.stderr(`WARN ${id} is logged, but not posted: ${problem}`);
        }
    }
    catch (error) {
        runtime.out.stderr(`WARN ${id} is logged, but not posted: ${errorMessage(error)}`);
    }
}
/** Posts `head` with its request's summary to `url`; undefined once posted, else why not. */
async function postProblem(runtime, team, url, id, head) {
    const record = (await stateOf(team)).records.get(id);
    if (record === undefined) {
        return `no request ${id} in the exec audit log`;
    }
    const { kind, target, task, requester } = record.request;
    const content = `teamrig exec ${team.kit.paths.team}: ${head} [${kind} on ${target} for ${task}, asked by ${requester}]`;
    return team.scanner.refusal('the post', content) ?? (await runtime.webhook.post(url, content));
}
/** A review in words, without its next step: the line the security channel gets. */
function reviewHead(review, owner) {
    switch (review.decision) {
        case 'approved':
            return `APPROVED ${review.id} by ${review.reviewer} until ${review.expiresAt ?? 'unset'}`;
        case 'refused':
            return `DECLINED ${review.id} by ${review.reviewer}: ${review.note}`;
        case 'escalated':
            return `ESCALATED ${review.id} by ${review.reviewer} to the owner (${owner}): ${review.note}`;
    }
}
/** A reviewer's decision (spec §7, §9), bound to the request and dry run the log holds when it is appended. */
async function review(args, runtime, decision) {
    const id = requestIdOf(onePositional(args, 'id'));
    const { team, reviewer } = await reviewerTeamOf(args, runtime);
    const ask = { id, decision, reviewer, note: args.flags.get('note') ?? '' };
    const leak = team.scanner.refusal('the note', ask.note);
    if (leak !== undefined) {
        throw new RefusedError(leak);
    }
    const owner = team.config.register.ownerSource;
    const kit = { reviewers: { owner, security: team.config.roles.securityReviewer }, signer: new UnsignedReviews(), nonces: RANDOM_NONCES };
    const line = await appendOrRefuse(team.audit, (state) => decideReview(state, ask, runtime.clock.now(), kit));
    const settled = appendedEvent(line, 'review').review;
    const head = reviewHead(settled, owner);
    runtime.out.stdout(settled.decision === 'approved' ? `${head}; next: teamrig exec run ${id}` : head);
    await announce(runtime, team, id, head);
    return EXIT.ok;
}
/** `exec approve R<n> [--note ..]`: approves the request for one run before its approval expires. */
export async function approve(args, runtime) {
    return review(args, runtime, 'approved');
}
/** `exec refuse R<n> --note ..`: refuses the request; the note names the safe alternative. */
export async function refuse(args, runtime) {
    return review(args, runtime, 'refused');
}
/** `exec escalate R<n> --note ..`: the security reviewer hands an owner-gated request on to the owner. */
export async function escalate(args, runtime) {
    return review(args, runtime, 'escalated');
}
/** Where a request stands now, from its record alone. */
function stageOf(record, now) {
    const { request: asked, dryRun: dry, escalation, review: settled, runStart, runEnd } = record;
    if (runEnd !== undefined) {
        return `ran, ${endOf(runEnd)}`;
    }
    if (runStart !== undefined) {
        return `running since ${runStart.at}, or stopped before its end was logged`;
    }
    if (settled !== undefined) {
        if (settled.decision !== 'approved') {
            return `refused by ${settled.reviewer}`;
        }
        const expired = settled.expiresAt !== null && Date.parse(settled.expiresAt) <= now;
        return expired ? `approved by ${settled.reviewer}, expired at ${settled.expiresAt ?? ''}` : `approved by ${settled.reviewer} until ${settled.expiresAt ?? 'unset'}: ready to run`;
    }
    if (escalation !== undefined) {
        return `escalated by ${escalation.reviewer}: waits for the owner`;
    }
    if (dry !== undefined) {
        return `dry run ${endOf(dry)}: waits for review`;
    }
    return asked.dryRunArgv === null ? 'waits for review of its preview' : 'waits for its dry run';
}
function namesText(names) {
    return names.length === 0 ? 'no variables' : names.join(', ');
}
function bindingText(binding) {
    return 'image' in binding ? `image ${binding.image}` : `${binding.repo} at ${binding.commit}, lockfile SHA-256 ${binding.lockSha256}`;
}
function outcomeLines(label, outcome) {
    if (outcome === undefined) {
        return [];
    }
    return [`  ${label}: ${endOf(outcome)} at ${outcome.at}; output ${outcome.outputFile} (SHA-256 ${outcome.outputSha256})`, ...tailLines(outcome.tail).map((line) => `    ${line}`)];
}
function reviewLines(reviewed) {
    if (reviewed === undefined) {
        return [];
    }
    const until = reviewed.expiresAt === null ? '' : ` until ${reviewed.expiresAt}`;
    return [`  ${reviewed.decision} by ${reviewed.reviewer} at ${reviewed.at}${until}: ${reviewed.note}`];
}
/** Everything a reviewer reads before deciding: the whole request, then each step the log holds. */
function detailLines(record, now) {
    const asked = record.request;
    const dryRunLine = asked.dryRunArgv === null
        ? `  preview: ${asked.preview ?? 'none'}`
        : `  dry run: ${JSON.stringify(asked.dryRunArgv)} (starts ${asked.dryRunProgram ?? 'unresolved'}) with ${namesText(asked.readEnvNames)}`;
    return [
        `${asked.id} ${asked.kind} for ${asked.task}, asked by ${asked.requester} at ${asked.createdAt}: ${stageOf(record, now)}`,
        `  target: ${asked.target}`,
        `  purpose: ${asked.purpose}`,
        `  expected: ${asked.expected}`,
        `  run: ${JSON.stringify(asked.argv)} (starts ${asked.program}) in ${asked.cwd} with ${namesText(asked.envNames)}, at most ${asked.maxRuntimeSec} s, ${asked.rerunSafe ? 'safe' : 'not safe'} to run twice`,
        dryRunLine,
        `  code: ${bindingText(asked.binding)}`,
        `  rollback: ${asked.rollback}`,
        `  window: ${asked.window === null ? 'none' : `${asked.window.runAfter} to ${asked.window.expiresBy}`}; owner-gated: ${asked.ownerGated ? 'yes' : 'no'}`,
        ...outcomeLines('dry run', record.dryRun),
        ...reviewLines(record.escalation),
        ...reviewLines(record.review),
        ...outcomeLines('run', record.runEnd),
    ];
}
/** `exec status [R<n>]`: each request's stage, or one request in full for its review. */
export async function status(args, runtime) {
    const [text, extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const id = text === undefined ? undefined : requestIdOf(text);
    const team = await readTeamOf(args, runtime);
    const state = await stateOf(team);
    const now = runtime.clock.now();
    if (id === undefined) {
        if (state.records.size === 0) {
            runtime.out.stdout(`EXEC no requests in ${team.kit.paths.execAudit}`);
        }
        state.records.forEach((record) => runtime.out.stdout(`${record.request.id} ${record.request.kind} for ${record.request.task} by ${record.request.requester} on ${record.request.target}: ${stageOf(record, now)}`));
        return EXIT.ok;
    }
    const record = state.records.get(id);
    if (record === undefined) {
        throw new RefusedError(`no request ${id} in the exec audit log`);
    }
    detailLines(record, now).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
