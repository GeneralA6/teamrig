import { QUEUE_TTL_MARGIN_MINUTES } from '../../config/defaults.ts';
import type { Roster } from '../../config/roster.ts';
import type { QueueConfig } from '../../config/types.ts';
import { busyText, holderText, isHeavyShare, underLock, waitText, type HostLockInfo, type StepNeed, type Taking } from '../../delivery/host-lock.ts';
import { parseLedger } from '../../delivery/ledger.ts';
import { pipelineFrozenRefusal } from '../../delivery/pipeline-freezes.ts';
import { deliveryPlaces, detachedLogOf } from '../../delivery/places.ts';
import { passOf, PRE_PUSH_MAX_WAIT_MS, recordPass, type CheckedTree, type CleanTree } from '../../delivery/push-pass.ts';
import { isStepKind, kindOfCommand, lineRequestOf, processRequest, STEP_KINDS, taskOfLabel, type ProcessRequest, type StepKind } from '../../delivery/process-request.ts';
import { recordRefusal, runRecorded, type RefusalMark, type StepOwner } from '../../delivery/recorded-step.ts';
import { stepNeedOf, type NeedAsk } from '../../delivery/step-need.ts';
import { causeOfLockWait, WaitLog } from '../../delivery/wait-log.ts';
import { queueCutoffReason, minutesText } from '../../delivery/schedule.ts';
import { endedText, type StarterWatching } from '../../delivery/starter-watch.ts';
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT, type StepEnd } from '../../delivery/steps.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { ENV } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { TimeZone } from '../../core/zone.ts';
import { TASK_ID } from '../../register/model.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { commandLine } from '../../test-run/shell.ts';
import { requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, type Say } from '../delivery-ports.ts';
import { commandWordsOf, sessionRef } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { parentLockOf } from '../parent-lock.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { rerunAdvice, stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { envSession, markedSessionOf } from './hook-input.ts';
import { inboxDepsOf } from './inbox.ts';

const MINUTE_MS = 60_000;

/**
 * `--max-minutes`: whole minutes from 1 to the lock's TTL less its margin, so the step never outlives its lock, and for
 * a small step to `smallMaxRunMinutes`, so a step that shares the host stays short; unset, the config's.
 */
function maxRunMinutesOf(args: ParsedArgs, config: QueueConfig, small: boolean): number {
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
function kindOf(args: ParsedArgs, words: readonly string[]): StepKind {
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
function taskOf(args: ParsedArgs, what: string): string | undefined {
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
function declaredMbOf(args: ParsedArgs): number | undefined {
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
function requestOf(args: ParsedArgs, words: readonly string[], what: string): ProcessRequest {
  return processRequest(kindOf(args, words), taskOf(args, what));
}

/** What the step's start is checked against: the queue cutoff, and the host's pipeline freezes on its kind. */
interface StartGate {
  readonly cutoffUtc: string | undefined;
  readonly pipelineFreezes: string;
  readonly kind: StepKind;
  readonly zone: TimeZone;
}

/** Why the step may not start now (the queue cutoff, or a pipeline freeze on its kind), or undefined when it may. */
async function startRefusal(runtime: CliRuntime, gate: StartGate): Promise<string | undefined> {
  const now = runtime.clock.now();
  return queueCutoffReason(now, gate.cutoffUtc, gate.zone) ?? pipelineFrozenRefusal(await runtime.files.read(gate.pipelineFreezes), gate.pipelineFreezes, now, [gate.kind], gate.zone);
}

async function refuseUnstartable(runtime: CliRuntime, gate: StartGate): Promise<void> {
  const reason = await startRefusal(runtime, gate);
  if (reason !== undefined) {
    throw new RefusedError(reason);
  }
}

/** Refuses a step that waited and did not run, after its refusal record (`recordRefusal`), with the reason it records. */
async function refuseWaited(runtime: CliRuntime, ledger: string, waits: WaitLog, mark: RefusalMark): Promise<never> {
  throw new RefusedError(await recordRefusal(runtime, ledger, waits, mark));
}

/**
 * `--exclusive`: the step takes the whole host (the lock file), waiting for every step sharing it, where a heavy step
 * would share the host under `pipeline` admission. A small step shares by definition, so the two flags refuse together.
 */
function exclusiveOf(args: ParsedArgs, small: boolean): boolean {
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
async function needOf(runtime: CliRuntime, ledger: string, ask: NeedAsk, config: QueueConfig): Promise<StepNeed> {
  return stepNeedOf(parseLedger((await runtime.files.read(ledger)) ?? ''), ask, config);
}

/**
 * The line a step holding `reserveMb` prints when it shares the host: the other steps of its own kind (small or heavy)
 * sharing it, then those of the other kind when any do.
 */
function sharingText(reserveMb: number, taking: Extract<Taking, { kind: 'taken' }>): string | undefined {
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
function stepCount(count: number, kind: string): string {
  return `${count} ${kind} step${count === 1 ? '' : 's'}`;
}

/** How a step's run ended: its exit code, and its last line (DONE, FAILED, TIMED OUT or STOPPED). */
interface Ended {
  readonly code: ExitCode;
  readonly last: string;
}

/** How the run ended, with the exit code the ledger recorded, said first when it was killed. */
function endedOf(say: Say, end: StepEnd, maxRunMinutes: number, watching: StarterWatching): Ended {
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
async function report(runtime: CliRuntime, say: Say, end: StepEnd, step: Step): Promise<ExitCode> {
  const ended = endedOf(say, end, step.maxRunMinutes, step.watching);
  runtime.out.stdout(ended.last);
  await step.reporting.ended(ended.last);
  return ended.code;
}

/** Who hears of a step besides its shell: a detached run's session, which no shell waits for; nobody otherwise. */
interface Reporting {
  /** The step got its turn and starts now. */
  started(): Promise<void>;
  /** The step ended, or never ran, as `last` says. */
  ended(last: string): Promise<void>;
}

const UNREPORTED: Reporting = { started: async () => undefined, ended: async () => undefined };

/** A detached run (`--detached-run`) as `--detach` started it: its id, its session and its log. */
interface DetachedRun {
  readonly id: string;
  readonly session: string;
  readonly what: string;
  readonly log: string;
}

/**
 * A detached run's session hears in its inbox when its step starts, and, with a wake, when it ends or is refused, since
 * no shell waits for its last line; a line that cannot be posted is said in the log, never failing the step.
 */
function detachedReporting(runtime: CliRuntime, kit: Kit, config: KitConfig, say: Say, run: DetachedRun): Reporting {
  const { id, session, what, log } = run;
  return {
    started: async () => {
      const text = `queue ${id} started: ${what}; log ${log}`;
      let problem: string | undefined;
      try {
        problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), { to: session, from: session, text, now: new Date(runtime.clock.now()) });
      } catch (error) {
        problem = errorMessage(error);
      }
      if (problem !== undefined) {
        say(`its start line was not posted to ${session}'s inbox: ${problem}`);
      }
    },
    ended: async (last) => {
      const problem = await postUrgentLine(runtime, kit, config, { to: session, from: session, text: `queue ${id} ended: ${what}: ${last}; log ${log}` });
      if (problem !== undefined) {
        say(`its end line was not posted to ${session}'s inbox: ${problem}`);
      }
    },
  };
}

/** A detached run has no shell to watch: `--detach`'s returned at once, so nothing stops it but its time limit. */
function unwatched(): StarterWatching {
  return { starters: [], stop: new AbortController().signal, ended: () => undefined, close: () => undefined };
}

/** The id `--detach` gives its run: the UTC second it started and the caller's process id, so two starts differ. */
export function detachedIdOf(now: number, pid: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${pid}`;
}

const DETACHED_ID = /^\d{8}-\d{6}-\d+$/;

/** `--detached-run`: the id of the run `--detach` started; set only by it. */
function detachedRunIdOf(args: ParsedArgs): string | undefined {
  const id = args.flags.get('detached-run');
  if (id !== undefined && !DETACHED_ID.test(id)) {
    throw new UsageError('--detached-run is set by --detach: run the step with --detach');
  }
  return id;
}

/**
 * `--detach`: checks a step needs its result at once refuse. A pre-push hook's checks decide its push; a step under a
 * live host lock is part of its parent step, which waits for it, and `--detached-run` is the run `--detach` starts.
 */
function refuseDetachUsage(args: ParsedArgs): void {
  if (args.switches.has('pre-push')) {
    throw new UsageError('--detach returns before the step runs and --pre-push decides a push by its result: give one of them');
  }
  if (args.flags.has('detached-run')) {
    throw new UsageError('--detached-run is set by --detach: give only --detach');
  }
}

/** The detached run's arguments: this command's flags and switches less `--detach`, its session resolved, its id added. */
function detachedArgsOf(args: ParsedArgs, words: readonly string[], session: string, id: string): string[] {
  const flags = [...args.flags].filter(([name]) => name !== 'session').flatMap(([name, value]) => [`--${name}`, value]);
  const switches = [...args.switches].filter((name) => name !== 'detach').map((name) => `--${name}`);
  return ['queue', '--detached-run', id, '--session', session, ...flags, ...switches, '--', ...words];
}

/**
 * Starts this step as a hidden `queue --detached-run` that outlives this command and its shell, its output and the
 * queue's lines in its log, then prints QUEUED: a step longer than a Bash tool's wait no longer holds one open, nor
 * dies with the shell Claude Code's reaper ends.
 */
async function startDetached(runtime: CliRuntime, places: { readonly log: string }, args: ParsedArgs, run: Omit<DetachedRun, 'log'> & { readonly words: readonly string[] }): Promise<ExitCode> {
  const { id, session, what, words } = run;
  const started = await runtime.processes.startHidden({
    command: runtime.self.node,
    args: [runtime.self.script, ...detachedArgsOf(args, words, session, id)],
    cwd: runtime.cwd,
    env: runtime.env,
    log: places.log,
  });
  if (started.kind !== 'started') {
    throw new RefusedError(`${what} did not start detached: ${started.kind === 'missing' ? `${runtime.self.node} was not found` : started.error}`);
  }
  runtime.out.stdout(`QUEUED ${id}: ${what} runs detached; log ${places.log}; ${session}'s inbox gets a line when it starts and when it ends`);
  return EXIT.ok;
}

/**
 * The step's session: `--session`, else `$TEAMRIG_SESSION`, else the parent step's (a git hook's checks under
 * `queue -- git commit` or a merge's push), else the session this Claude Code tab is bound to, so a hook
 * that wraps its checks in `queue` needs no session of its own.
 */
async function sessionOf(args: ParsedArgs, runtime: CliRuntime, kit: Kit, roster: Roster, parent: HostLockInfo | undefined): Promise<string> {
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
async function runUnderParent(runtime: CliRuntime, say: Say, parent: string, step: Step): Promise<ExitCode> {
  const { what, words, maxRunMinutes, watching } = step;
  say(`running: ${what} under the host lock of ${parent} (killed after ${minutesText(maxRunMinutes)})`);
  await step.reporting.started();
  const end = await runtime.steps.run({ command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: runtime.env, timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop });
  return report(runtime, say, end, step);
}

/** `--pre-push`: the checks' command line and the tree they start on, so their pass is reused or recorded. */
interface PrePush {
  readonly command: string;
  readonly before: CheckedTree;
}

/**
 * True, having said so and printed DONE, when these checks already passed on this clean tree, so a push declined after
 * a long wait for the lock goes at once the next time: even from the queue cutoff on, since it runs nothing.
 */
async function reusedPass(runtime: CliRuntime, say: Say, prePush: PrePush, zone: TimeZone): Promise<boolean> {
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
function passedTree(before: CheckedTree, after: CheckedTree): CleanTree | undefined {
  return before.kind === 'clean' && after.kind === 'clean' && after.tree === before.tree ? after : undefined;
}

/** Why checks that passed got no pass recorded. */
function noPassText(before: CheckedTree, after: CheckedTree): string {
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
async function afterPrePush(runtime: CliRuntime, prePush: PrePush, what: string, code: ExitCode, waitedMs: number): Promise<ExitCode> {
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
 * One queued step as asked: its label, its command's words, its time limit, the watch on the shell that started it and
 * who else hears of it.
 */
interface Step {
  readonly what: string;
  readonly words: readonly string[];
  readonly maxRunMinutes: number;
  readonly watching: StarterWatching;
  readonly reporting: Reporting;
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
 * shares the host with other small steps, holding its need or `smallReserveMb`; a heavy step shares it too under
 * `pipeline` admission, at most `maxHeavyParallel` at once, and takes the lock, waiting for every share to end, under
 * `serial` or with `--exclusive`. A small step is killed after `smallMaxRunMinutes` instead, and its `--max-minutes`
 * goes no higher. Once the shell that started it ends (Claude Code's
 * reaper ends a Bash tool's shell alone), it stops waiting for the lock, or kills its step and records exit 129, and
 * frees the lock. With `--pre-push` (a git pre-push hook's checks) it reuses their fresh pass on a clean tree, records
 * one when they pass, and declines a push whose checks waited past PRE_PUSH_MAX_WAIT_MS for the lock (push-pass.ts).
 * Exit 0 when the command passed, 1 when it failed, was killed or was stopped, 2 refused.
 */
export async function queue(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const words = commandWordsOf(args);
  const what = requiredFlag(args.flags, 'what');
  const request = requestOf(args, words, what);
  const declaredMb = declaredMbOf(args);
  const detach = args.switches.has('detach');
  if (detach) {
    refuseDetachUsage(args);
  }
  const detachedId = detachedRunIdOf(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { delivery } = config;
  const zone = teamZone(config, runtime);
  const say = logLineOf(runtime, zone);
  const small = args.switches.has('small');
  const exclusive = exclusiveOf(args, small);
  const maxRunMinutes = maxRunMinutesOf(args, delivery.queue, small);
  const places = deliveryPlaces(delivery, kit.paths);
  const lock = hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom, config.focus, zone);
  const parent = await parentLockOf(runtime, lock, say);
  const session = await sessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), parent);
  const gate: StartGate = { cutoffUtc: delivery.schedule.queueCutoffUtc, pipelineFreezes: places.pipelineFreezes, kind: request.kind, zone };
  if (detach) {
    if (parent !== undefined) {
      throw new UsageError('--detach under a live host lock: a step a queued step starts runs at once under its lock, and that step waits for its result; run it without --detach');
    }
    await refuseUnstartable(runtime, gate);
    const id = detachedIdOf(runtime.clock.now(), runtime.pid);
    return await startDetached(runtime, { log: detachedLogOf(delivery, kit.paths, id) }, args, { id, session, what, words });
  }
  const reporting = detachedId === undefined ? UNREPORTED : detachedReporting(runtime, kit, config, say, { id: detachedId, session, what, log: detachedLogOf(delivery, kit.paths, detachedId) });
  const watching = detachedId === undefined ? await watchStarters(runtime, say) : unwatched();
  try {
    const step: Step = { what, words, maxRunMinutes, watching, reporting };
    const prePush: PrePush | undefined = args.switches.has('pre-push') ? { command: commandLine(words, runtime.platform), before: runtime.trees.checked(runtime.cwd) } : undefined;
    if (prePush !== undefined && (await reusedPass(runtime, say, prePush, zone))) {
      return EXIT.ok;
    }
    if (parent !== undefined) {
      const code = await runUnderParent(runtime, say, holderText({ kind: 'held', info: parent }, zone), step);
      return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, 0);
    }
    await refuseUnstartable(runtime, gate);
    // The register is read only for a step that queues: a nested step or one refused at once records nothing.
    const register = new JsonlEventLog(runtime.files, kit.paths.events);
    const line = await lineRequestOf(request, async (id) => (await register.read()).state.tasks.get(id), config.focus);
    // Only the ticket carries the class for now: the ledger's start and refusal records keep the fields their readers take.
    const owner: StepOwner = { session, ...processRequest(line.kind, line.task, line.priority) };
    const waits = new WaitLog(runtime.clock, runtime.memory.freeMb());
    const need = await needOf(runtime, places.ledger, { session, what, kind: request.kind, small, ...(declaredMb === undefined ? {} : { declaredMb }) }, delivery.queue);
    const waiting = small ? 'waiting to share the host' : 'waiting for the host lock';
    const taking = await unlessStopped(
      watching.stop,
      lock.acquire(
        session,
        `heavy: ${what}`,
        delivery.queue.waitMinutes * MINUTE_MS,
        delivery.wait.pollSeconds * 1_000,
        (holder, ahead) => {
          const text = `${waiting}: ${waitText(holder, ahead, zone)}`;
          waits.tell({ cause: causeOfLockWait(holder), text });
          say(text);
        },
        { need, request: line, exclusive },
        watching.stop,
      ),
    );
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
      const run = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: underLock(runtime.env, taking.lock), timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop };
      const mark = { ...owner, what, ...waited, ...(taking.sharing === undefined || taking.sharing.heavy ? {} : { shared: true as const }), request: run };
      const end = await runRecorded(runtime, { places, delivery }, mark);
      const code = await report(runtime, say, end, step);
      return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, waitedMs);
    } finally {
      await lock.release(taking.lock);
    }
  } catch (error) {
    // A step refused, or a queue that broke, ends with no last line of its own; a detached run's session hears why.
    await reporting.ended(error instanceof RefusedError ? `REFUSED ${error.message}` : `FAILED ${errorMessage(error)}`);
    throw error;
  } finally {
    watching.close();
  }
}
