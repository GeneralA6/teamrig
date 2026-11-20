import { resolve } from 'node:path';
import { roleHolderOf } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import type { PathSearchDeps } from '../../core/path-search.ts';
import { SecretScanner } from '../../core/secrets.ts';
import {
  activePin,
  AuditChainError,
  AuditLog,
  nextPinId,
  nextRequestId,
  REQUEST_ID,
  type AuditDecision,
  type AuditEvent,
  type AuditLine,
  type AuditState,
  type PinRecord,
  type PinReview,
  type RequestRecord,
  type Review,
  type ReviewDecision,
  type RunOutcome,
  type Stamped,
} from '../../exec/audit.ts';
import { resolveProgram } from '../../exec/binding.ts';
import { nodeLaunchRefusal } from '../../exec/node-launch.ts';
import { parseDraft, type CodeBinding, type ExecRequest } from '../../exec/request.ts';
import { decidePinReview, decideReview, pinSignatureValid, RANDOM_NONCES, UnsignedReviews, type ReviewAsk, type ReviewKit } from '../../exec/review.ts';
import { baseEnvironment, environmentCredentials, Executor, type ExecResult } from '../../exec/runner.ts';
import { HASH_PREFIX, PIN_ID, runtimeRefusal, shasumsUrl, type RuntimeImage, type RuntimePin } from '../../exec/runtime-pin.ts';
import { noPositionals, onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { postToHolder, sessionNameOn, type OpenTeam } from '../holder-team.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, type Access, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { fileLockOf } from '../file-locks.ts';

/** What every exec command works on: the team's kit and config, its exec audit log, and the exec PATH. */
interface ExecTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly audit: AuditLog;
  /** The folders reviewed programs come from (exec.path), joined as a PATH value. */
  readonly execPath: string;
  readonly search: PathSearchDeps;
  /** The Node.js program this client runs under, which a request's bare `node` starts (#870). */
  readonly node: string;
  readonly scanner: SecretScanner;
}

/** Refuses an exec command on a node started with an option that can run code beside the pinned client (T1036). */
function refuseForeignLaunch(runtime: CliRuntime): void {
  const refusal = nodeLaunchRefusal(runtime.self.execArgv, runtime.env, runtime.platform);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
}

async function openExec(runtime: CliRuntime, access: Access): Promise<ExecTeam> {
  refuseForeignLaunch(runtime);
  const kit = await openTeamKit(runtime);
  return execTeamOf(runtime, kit, requireConfig(kit, runtime, access));
}

function execTeamOf(runtime: CliRuntime, kit: Kit, config: KitConfig): ExecTeam {
  const { files, clock, platform } = runtime;
  const lock = fileLockOf(runtime, kit.paths.execAuditLock, config.lock);
  const execPath = config.exec.path.join(platform === 'win32' ? ';' : ':');
  return {
    kit,
    config,
    audit: new AuditLog(kit.paths.execAudit, files, lock, clock),
    execPath,
    search: { env: { PATH: execPath }, platform, probe: runtime.probe },
    node: runtime.self.node,
    scanner: new SecretScanner(config.register.secretPatterns),
  };
}

/** The caller as the log names it: the owner's marker (register.ownerSource) or a session's id, self-declared in phase 1 (spec §4). */
async function actorOf(args: ParsedArgs, runtime: CliRuntime, team: ExecTeam): Promise<string> {
  const caller = callerOf(args.flags, runtime.env);
  return caller === team.config.register.ownerSource ? caller : sessionIdOf(await rosterOf(runtime, team.kit, team.config), caller);
}

/** A team below the caller's that `--team <child>` names, as a reviewer on a team above it reads and reviews its requests (T1143). */
interface ChildExec {
  readonly team: ExecTeam;
  /** The caller's own team. */
  readonly own: OpenTeam;
}

async function childExecOf(runtime: CliRuntime, child: string, access: Access): Promise<ChildExec> {
  refuseForeignLaunch(runtime);
  const kit = await openTeamKit(runtime);
  const own: OpenTeam = { kit, config: requireConfig(kit, runtime, 'read') };
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
async function readTeamOf(args: ParsedArgs, runtime: CliRuntime): Promise<ExecTeam> {
  const child = args.flags.get('team');
  return child === undefined ? openExec(runtime, 'read') : (await childExecOf(runtime, child, 'read')).team;
}

/**
 * The exec team a review goes to, and the reviewer as its log names them: the caller's own team (actorOf), or with
 * `--team <child>` a team below it, where the owner keeps its marker and a session of the caller's team is
 * `<team>/<id>`, the form the child's roles.securityReviewer names a reviewer above it by; decideReview refuses anyone else.
 */
async function reviewerTeamOf(args: ParsedArgs, runtime: CliRuntime): Promise<{ readonly team: ExecTeam; readonly reviewer: string }> {
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

function brokenLog(file: string, line: number, reason: string): RefusedError {
  return new RefusedError(`the exec audit log is broken at ${file} line ${line}: ${reason}; nothing more is written to it`);
}

/** Runs `step`, turning a broken audit log into a refusal. */
async function onSoundLog<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AuditChainError) {
      throw brokenLog(error.file, error.line, error.reason);
    }
    throw error;
  }
}

/** Appends the event `decide` picks under the log's lock, or refuses with its reason. */
async function appendOrRefuse(audit: AuditLog, decide: (state: AuditState) => AuditDecision): Promise<AuditLine> {
  const result = await onSoundLog(() => audit.append(decide));
  if (!result.ok) {
    throw new RefusedError(result.refusal);
  }
  return result.line;
}

function isEventOf<T extends AuditEvent['type']>(event: AuditEvent, type: T): event is Extract<AuditEvent, { readonly type: T }> {
  return event.type === type;
}

/** The event of the line a command just appended; any other type than the one it appended is a bug. */
function appendedEvent<T extends AuditEvent['type']>(line: AuditLine, type: T): Extract<AuditEvent, { readonly type: T }> {
  const { event } = line;
  if (!isEventOf(event, type)) {
    throw new Error(`exec audit line ${line.seq} holds a ${event.type} event, not the ${type} just appended`);
  }
  return event;
}

async function stateOf(team: ExecTeam): Promise<AuditState> {
  const read = await team.audit.read();
  if (!read.ok) {
    throw brokenLog(team.kit.paths.execAudit, read.line, read.reason);
  }
  return read.state;
}

function requestIdOf(text: string): string {
  if (!REQUEST_ID.test(text)) {
    throw new UsageError(`"${text}" is not a request id (R1, R2, ...)`);
  }
  return text;
}

/** A request's id, or a runtime pin's (#870): what a review or `status` names. */
function reviewIdOf(text: string): string {
  if (!REQUEST_ID.test(text) && !PIN_ID.test(text)) {
    throw new UsageError(`"${text}" is not a request id (R1, R2, ...) or a runtime pin id (P1, P2, ...)`);
  }
  return text;
}

/** The runtime this client runs under; one it cannot read refuses, as nothing can be checked. */
async function currentRuntime(runtime: CliRuntime): Promise<RuntimeImage> {
  try {
    return await runtime.exec.runtime.current();
  } catch (error) {
    throw new RefusedError(`teamrig exec cannot read the Node.js runtime it runs under: ${errorMessage(error)}`);
  }
}

/**
 * Refuses a dry run or a run unless this client runs under the runtime of the latest approved pin (#870): its real
 * path and the SHA-256 of its binary, read anew on each call.
 */
async function refuseUnpinnedRuntime(runtime: CliRuntime, team: ExecTeam): Promise<void> {
  const pinned = activePin(await stateOf(team));
  if (pinned?.review !== undefined && !pinSignatureValid(pinned.review, new UnsignedReviews())) {
    throw new RefusedError(`${pinned.pin.id}'s approval signature is not valid for what it binds`);
  }
  const refusal = runtimeRefusal(await currentRuntime(runtime), pinned?.pin, runtime.platform);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
}

async function requestFileJson(runtime: CliRuntime, path: string): Promise<unknown> {
  const text = await runtime.files.read(path);
  if (text === undefined) {
    throw new RefusedError(`no request file ${path}`);
  }
  try {
    const raw: unknown = JSON.parse(text);
    return raw;
  } catch (error) {
    throw new RefusedError(`${path} is not JSON: ${errorMessage(error)}`);
  }
}

/** The file `argv[0]` starts, found on the exec PATH; a refusal names the folders searched. */
async function programOf(field: string, argv: readonly string[], team: ExecTeam): Promise<string> {
  const [argv0 = ''] = argv;
  const program = await resolveProgram(argv0, team.search, team.node);
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
export async function request(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
function firstReviewerOf(config: KitConfig, team: string, requester: string): SessionAddress {
  const security = roleHolderOf(config.roles, 'securityReviewer', team);
  return security === undefined || (security.team === team && security.id === requester) ? { team, id: config.register.ownerSource } : security;
}

/**
 * Posts the first reviewer one inbox line for a logged request, on the reviewer's own team when it sits above this one,
 * where the line names the requester and the team to review on; a line that cannot be posted warns, as the request stands.
 */
async function tellReviewer(runtime: CliRuntime, team: ExecTeam, stored: ExecRequest): Promise<void> {
  await tellFirstReviewer(runtime, team, stored.id, stored.requester, `${stored.id} asks to run a ${stored.kind} on ${stored.target} for ${stored.task}`);
}

/** Posts the first reviewer of `id` (a request or a runtime pin) `ask`, with the command that shows it for review. */
async function tellFirstReviewer(runtime: CliRuntime, team: ExecTeam, id: string, requester: string, ask: string): Promise<void> {
  const own = team.kit.paths.team;
  const reviewer = firstReviewerOf(team.config, own, requester);
  const crossing = reviewer.team !== own;
  const label = sessionNameOn(own, reviewer.team, reviewer.id);
  const text = `${ask}: review it (teamrig exec status ${id}${crossing ? ` --team ${own}` : ''})`;
  const problem = await postToHolder(runtime, team, reviewer, { from: requester, text });
  runtime.out.stderr(problem === undefined ? `NOTE ${label} has an inbox line: ${text}` : `WARN ${id} is logged, but ${label} was not told: ${problem}`);
}

/**
 * `exec node-pin`: files the Node.js runtime this client runs under (its real path, the SHA-256 of its binary and its
 * version) as the next P<n> for review (#870). Once approved, dry runs and runs start only under it; after a Node.js
 * upgrade the owner files the new one from their own terminal.
 */
export async function nodePin(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const team = await openExec(runtime, 'write');
  const requester = await actorOf(args, runtime, team);
  const image = await currentRuntime(runtime);
  const createdAt = new Date(runtime.clock.now()).toISOString();
  const line = await appendOrRefuse(team.audit, (state) => ({ type: 'pin-request', pin: { id: nextPinId(state), ...image, requester, createdAt } }));
  const { pin } = appendedEvent(line, 'pin-request');
  runtime.out.stdout(`PIN REQUESTED ${pin.id}: Node.js ${pin.version} at ${pin.path}, SHA-256 ${pin.sha256}; next: a reviewer checks it (teamrig exec status ${pin.id}), then approves or refuses it`);
  await tellFirstReviewer(runtime, team, pin.id, pin.requester, `${pin.id} asks to pin the Node.js runtime ${pin.version} at ${pin.path}`);
  return EXIT.ok;
}

function executorOf(team: ExecTeam, runtime: CliRuntime): Executor {
  return new Executor({
    audit: team.audit,
    binding: { checkout: runtime.exec.checkout, search: team.search, node: team.node },
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
function endOf(outcome: RunOutcome): string {
  if (outcome.timedOut) {
    return 'timed out';
  }
  return outcome.exitCode === null ? 'ended with no exit code' : `exit ${outcome.exitCode}`;
}

function tailLines(tail: string): string[] {
  return tail.split('\n').filter((line, index, lines) => line !== '' || index < lines.length - 1);
}

/** The outcome of a dry run or a run that started; a refusal throws. */
function startedOutcome(result: ExecResult): RunOutcome {
  if (!result.ok) {
    throw new RefusedError(result.refusal);
  }
  return result.outcome;
}

/** Prints a dry run's or a run's end and its output's tail; an unclean end fails. */
function printOutcome(runtime: CliRuntime, head: string, outcome: RunOutcome, next: string | undefined): ExitCode {
  const clean = outcome.exitCode === 0 && !outcome.timedOut;
  const then = clean && next !== undefined ? `; next: ${next}` : '';
  runtime.out.stdout(`${head}: ${endOf(outcome)}; output ${outcome.outputFile} (SHA-256 ${outcome.outputSha256})${then}`);
  tailLines(outcome.tail).forEach((line) => runtime.out.stdout(`  ${line}`));
  return clean ? EXIT.ok : EXIT.failed;
}

/** `exec dry-run R<n>`: runs the request's read-only dry run with its read variables, and logs it for the reviewer (spec §6). */
export async function dryRun(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = requestIdOf(onePositional(args, 'id'));
  const team = await openExec(runtime, 'write');
  await refuseUnpinnedRuntime(runtime, team);
  const outcome = startedOutcome(await onSoundLog(() => executorOf(team, runtime).dryRun(id)));
  return printOutcome(runtime, `DRY RUN ${id}`, outcome, `the reviewer reads it (teamrig exec status ${id}), then approves, refuses or escalates it`);
}

/** `exec run R<n>`: runs an approved request once (spec §8); the logged start burns the approval. */
export async function run(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = requestIdOf(onePositional(args, 'id'));
  const team = await openExec(runtime, 'write');
  await refuseUnpinnedRuntime(runtime, team);
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
async function announce(runtime: CliRuntime, team: ExecTeam, id: string, head: string): Promise<void> {
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
  } catch (error) {
    runtime.out.stderr(`WARN ${id} is logged, but not posted: ${errorMessage(error)}`);
  }
}

/** Posts `head` with its request's summary to `url`; undefined once posted, else why not. */
async function postProblem(runtime: CliRuntime, team: ExecTeam, url: string, id: string, head: string): Promise<string | undefined> {
  const state = await stateOf(team);
  const pinned = state.pins.get(id);
  const record = state.records.get(id);
  if (pinned === undefined && record === undefined) {
    return `no request ${id} in the exec audit log`;
  }
  const summary = record === undefined ? `runtime pin, asked by ${pinned?.pin.requester ?? ''}` : `${record.request.kind} on ${record.request.target} for ${record.request.task}, asked by ${record.request.requester}`;
  const content = `teamrig exec ${team.kit.paths.team}: ${head} [${summary}]`;
  return team.scanner.refusal('the post', content) ?? (await runtime.webhook.post(url, content));
}

/** A review in words, without its next step: the line the security channel gets. */
function reviewHead(review: Review, owner: string): string {
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
async function review(args: ParsedArgs, runtime: CliRuntime, decision: ReviewDecision): Promise<ExitCode> {
  const id = reviewIdOf(onePositional(args, 'id'));
  const { team, reviewer } = await reviewerTeamOf(args, runtime);
  const ask = { id, decision, reviewer, note: args.flags.get('note') ?? '' };
  const leak = team.scanner.refusal('the note', ask.note);
  if (leak !== undefined) {
    throw new RefusedError(leak);
  }
  if (PIN_ID.test(id)) {
    return reviewPin(runtime, team, ask);
  }
  const owner = team.config.register.ownerSource;
  const kit: ReviewKit = { reviewers: { owner, security: team.config.roles.securityReviewer }, signer: new UnsignedReviews(), nonces: RANDOM_NONCES };
  const line = await appendOrRefuse(team.audit, (state) => decideReview(state, ask, runtime.clock.now(), kit));
  const settled = appendedEvent(line, 'review').review;
  const head = reviewHead(settled, owner);
  runtime.out.stdout(settled.decision === 'approved' ? `${head}; next: teamrig exec run ${id}` : head);
  await announce(runtime, team, id, head);
  return EXIT.ok;
}

/** A runtime pin's review in words: the line the security channel gets. */
function pinReviewHead(review: PinReview, pin: RuntimePin): string {
  return review.decision === 'approved'
    ? `APPROVED ${review.id} by ${review.reviewer}: dry runs and runs start only under Node.js ${pin.version} at ${pin.path} (SHA-256 ${pin.sha256.slice(0, HASH_PREFIX)})`
    : `DECLINED ${review.id} by ${review.reviewer}: ${review.note}`;
}

/** A reviewer's decision on a runtime pin (#870), bound to the pin the log holds when it is appended. */
async function reviewPin(runtime: CliRuntime, team: ExecTeam, ask: ReviewAsk): Promise<ExitCode> {
  const reviewers = { owner: team.config.register.ownerSource, security: team.config.roles.securityReviewer };
  const line = await appendOrRefuse(team.audit, (state) => decidePinReview(state, ask, { reviewers, signer: new UnsignedReviews() }));
  const settled = appendedEvent(line, 'pin-review').review;
  const pinned = (await stateOf(team)).pins.get(settled.id);
  const head = pinned === undefined ? `${settled.decision.toUpperCase()} ${settled.id}` : pinReviewHead(settled, pinned.pin);
  runtime.out.stdout(head);
  await announce(runtime, team, ask.id, head);
  return EXIT.ok;
}

/** `exec approve R<n> [--note ..]`: approves the request for one run before its approval expires. */
export async function approve(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  return review(args, runtime, 'approved');
}

/** `exec refuse R<n> --note ..`: refuses the request; the note names the safe alternative. */
export async function refuse(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  return review(args, runtime, 'refused');
}

/** `exec escalate R<n> --note ..`: the security reviewer hands an owner-gated request on to the owner. */
export async function escalate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  return review(args, runtime, 'escalated');
}

/** Where a request stands now, from its record alone. */
function stageOf(record: RequestRecord, now: number): string {
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

function namesText(names: readonly string[]): string {
  return names.length === 0 ? 'no variables' : names.join(', ');
}

function bindingText(binding: CodeBinding): string {
  return 'image' in binding ? `image ${binding.image}` : `${binding.repo} at ${binding.commit}, lockfile SHA-256 ${binding.lockSha256}`;
}

function outcomeLines(label: string, outcome: Stamped<RunOutcome> | undefined): string[] {
  if (outcome === undefined) {
    return [];
  }
  return [`  ${label}: ${endOf(outcome)} at ${outcome.at}; output ${outcome.outputFile} (SHA-256 ${outcome.outputSha256})`, ...tailLines(outcome.tail).map((line) => `    ${line}`)];
}

function reviewLines(reviewed: Stamped<Review> | undefined): string[] {
  if (reviewed === undefined) {
    return [];
  }
  const until = reviewed.expiresAt === null ? '' : ` until ${reviewed.expiresAt}`;
  return [`  ${reviewed.decision} by ${reviewed.reviewer} at ${reviewed.at}${until}: ${reviewed.note}`];
}

/** Everything a reviewer reads before deciding: the whole request, then each step the log holds. */
function detailLines(record: RequestRecord, now: number): string[] {
  const asked = record.request;
  const dryRunLine =
    asked.dryRunArgv === null
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

/** Where a runtime pin stands: waiting, refused, the active one, or replaced by a later approval. */
function pinStageOf(record: PinRecord, state: AuditState): string {
  const { review: settled } = record;
  if (settled === undefined) {
    return 'waits for review';
  }
  if (settled.decision === 'refused') {
    return `refused by ${settled.reviewer}`;
  }
  return state.activePin === record.pin.id ? `approved by ${settled.reviewer}: dry runs and runs start under it` : `approved by ${settled.reviewer}, replaced by ${state.activePin ?? 'none'}`;
}

/** Everything a reviewer reads before settling a runtime pin, with the check they make first. */
function pinDetailLines(record: PinRecord, state: AuditState): string[] {
  const { pin, review: settled } = record;
  return [
    `${pin.id} runtime pin, asked by ${pin.requester} at ${pin.createdAt}: ${pinStageOf(record, state)}`,
    `  path: ${pin.path}`,
    `  SHA-256: ${pin.sha256}`,
    `  version: ${pin.version}`,
    `  check before approving: the SHA-256 is this platform's binary in ${shasumsUrl(pin.version)}, or a distro build's package manager verifies the file`,
    ...(settled === undefined ? [] : [`  ${settled.decision} by ${settled.reviewer} at ${settled.at}: ${settled.note}`]),
  ];
}

/** `exec status [R<n>|P<n>]`: each request's and runtime pin's stage, or one in full for its review. */
export async function status(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [text, extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const id = text === undefined ? undefined : reviewIdOf(text);
  const team = await readTeamOf(args, runtime);
  const state = await stateOf(team);
  const now = runtime.clock.now();
  if (id === undefined) {
    if (state.records.size === 0 && state.pins.size === 0) {
      runtime.out.stdout(`EXEC no requests in ${team.kit.paths.execAudit}`);
    }
    state.records.forEach((record) => runtime.out.stdout(`${record.request.id} ${record.request.kind} for ${record.request.task} by ${record.request.requester} on ${record.request.target}: ${stageOf(record, now)}`));
    state.pins.forEach((record) => runtime.out.stdout(`${record.pin.id} runtime pin by ${record.pin.requester}: Node.js ${record.pin.version} at ${record.pin.path}: ${pinStageOf(record, state)}`));
    return EXIT.ok;
  }
  if (PIN_ID.test(id)) {
    const pinned = state.pins.get(id);
    if (pinned === undefined) {
      throw new RefusedError(`no runtime pin ${id} in the exec audit log`);
    }
    pinDetailLines(pinned, state).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
  }
  const record = state.records.get(id);
  if (record === undefined) {
    throw new RefusedError(`no request ${id} in the exec audit log`);
  }
  detailLines(record, now).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}
