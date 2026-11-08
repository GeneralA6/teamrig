import { QUEUE_TTL_MARGIN_MINUTES } from '../../config/defaults.ts';
import type { Roster } from '../../config/roster.ts';
import type { QueueConfig } from '../../config/types.ts';
import { busyText, holderText, underLock, waitText, type HostLock, type HostLockInfo, type StepNeed, type Taking } from '../../delivery/host-lock.ts';
import { parseLedger } from '../../delivery/ledger.ts';
import { deliveryPlaces } from '../../delivery/places.ts';
import { passOf, PRE_PUSH_MAX_WAIT_MS, recordPass, type CheckedTree, type CleanTree } from '../../delivery/push-pass.ts';
import { runRecorded, type StepWatch } from '../../delivery/recorded-step.ts';
import { queueCutoffReason, minutesText } from '../../delivery/schedule.ts';
import { endedText, type StarterWatching } from '../../delivery/starter-watch.ts';
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT, type StepEnd } from '../../delivery/steps.ts';
import { ENV } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { commandLine } from '../../test-run/shell.ts';
import { requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, type Say } from '../delivery-ports.ts';
import { commandWordsOf, sessionRef } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';
import { envSession, markedSessionOf } from './hook-input.ts';

const MINUTE_MS = 60_000;

/** A step's measured reserve is read from at most this many of its latest ended runs. */
const RESERVE_RUNS = 20;

/** A step's measured reserve is the most its latest runs held, with this margin. */
const RESERVE_MARGIN = 1.25;

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

function refuseAfterCutoff(runtime: CliRuntime, cutoffUtc: string | undefined, zone: TimeZone): void {
  const reason = queueCutoffReason(runtime.clock.now(), cutoffUtc, zone);
  if (reason !== undefined) {
    throw new RefusedError(reason);
  }
}

/** How the step's memory is watched: its own process's tree, as often as the config says; undefined when it says 0. */
function watchOf(runtime: CliRuntime, config: QueueConfig): StepWatch | undefined {
  return config.memorySampleSeconds === 0 ? undefined : { memory: runtime.memory, root: runtime.pid, intervalMs: config.memorySampleSeconds * 1_000 };
}

/**
 * The most a step's process tree held in its latest `RESERVE_RUNS` ended runs, under the same session and label in the
 * ledger, with a quarter more; undefined when none was measured.
 */
async function measuredReserveMbOf(runtime: CliRuntime, ledger: string, session: string, what: string): Promise<number | undefined> {
  const records = parseLedger((await runtime.files.read(ledger)) ?? '');
  const peaks = records.flatMap((record) => (record.type === 'heavy' && record.session === session && record.what === what && record.peakTreeMb !== undefined ? [record.peakTreeMb] : []));
  const latest = peaks.slice(-RESERVE_RUNS);
  return latest.length === 0 ? undefined : Math.ceil(Math.max(...latest) * RESERVE_MARGIN);
}

/**
 * What the step asks of the host: a small step shares it, holding its measured reserve or the config's
 * `smallReserveMb`; a heavy one takes the lock, holding its measured reserve or `heavyReserveMb`, whichever is more, so
 * a step known to peak higher waits for that much room.
 */
async function needOf(runtime: CliRuntime, ledger: string, session: string, what: string, small: boolean, config: QueueConfig): Promise<StepNeed> {
  const measuredMb = await measuredReserveMbOf(runtime, ledger, session, what);
  return small ? { shares: true, reserveMb: measuredMb ?? config.smallReserveMb } : { shares: false, reserveMb: Math.max(measuredMb ?? 0, config.heavyReserveMb) };
}

/** The line a small step holding `reserveMb` prints when it shares the host. */
function sharingText(reserveMb: number, taking: Extract<Taking, { kind: 'taken' }>): string | undefined {
  if (taking.sharing === undefined) {
    return undefined;
  }
  const others = taking.sharing.others.length;
  const free = taking.sharing.freeMb === undefined ? '' : `${taking.sharing.freeMb} MB free, `;
  return `sharing the host: ${reserveMb} MB held for it (${free}${others} other small step${others === 1 ? '' : 's'})`;
}

/** The last line: DONE, FAILED, TIMED OUT or STOPPED, with the exit code the ledger recorded. */
function report(runtime: CliRuntime, say: Say, end: StepEnd, maxRunMinutes: number, watching: StarterWatching): ExitCode {
  switch (end.kind) {
    case 'stopped':
      say(`its launching shell ended (${endedText(watching)}): killed its process tree`);
      runtime.out.stdout(`STOPPED killed, recorded as exit ${STOPPED_EXIT}`);
      return EXIT.failed;
    case 'timedOut':
      say(`timed out after ${minutesText(maxRunMinutes)}: killed its process tree`);
      runtime.out.stdout(`TIMED OUT killed, recorded as exit ${TIMED_OUT_EXIT}`);
      return EXIT.failed;
    case 'signal':
      runtime.out.stdout(`FAILED stopped by ${end.signal}, recorded as exit ${exitCodeOf(end)}`);
      return EXIT.failed;
    case 'exited':
      runtime.out.stdout(end.code === 0 ? 'DONE exit 0' : `FAILED exit ${end.code}`);
      return end.code === 0 ? EXIT.ok : EXIT.failed;
  }
}

/**
 * The lock of the step that started this one, from `$TEAMRIG_HOST_LOCK`, while that step still holds it; undefined when
 * the variable is unset or names no live lock (a leftover in a shell), which is said, since the step then waits as usual.
 */
async function parentLockOf(runtime: CliRuntime, lock: HostLock, say: Say): Promise<HostLockInfo | undefined> {
  const token = runtime.env[ENV.hostLock]?.trim();
  if (token === undefined || token === '') {
    return undefined;
  }
  const held = await lock.heldWith(token);
  if (held === undefined) {
    say(`$${ENV.hostLock} names no live host lock: taking the lock as usual`);
  }
  return held;
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
  const end = await runtime.steps.run({ command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: runtime.env, timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop });
  return report(runtime, say, end, maxRunMinutes, watching);
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

/** One queued step as asked: its label, its command's words, its time limit and the watch on the shell that started it. */
interface Step {
  readonly what: string;
  readonly words: readonly string[];
  readonly maxRunMinutes: number;
  readonly watching: StarterWatching;
}

/**
 * `teamrig queue --what <label> -- <command ...>`: runs one queued step (a build, a test run, a database script)
 * under the host lock, so the host's queued steps run one at a time. Refused from `delivery.schedule.queueCutoffUtc`
 * to midnight UTC, also when the wait for the lock ran past it, and once its line for the lock has not moved for
 * `delivery.queue.waitMinutes`. The step is killed with every process it started after `maxRunMinutes`
 * (`--max-minutes`), and its start and end go to the delivery ledger, with when it began to wait and, sampled
 * every `memorySampleSeconds`, the most its process tree held and the least free memory the host had. Its processes get `$TEAMRIG_HOST_LOCK`,
 * so a `queue` among them (a git hook's checks) runs at once under this lock. Every step waits in its turn until the
 * host's free memory leaves `memoryFloorMb` besides the MB held for it and for the small steps sharing the host
 * (`hostLockOf`'s memory gate): for a step that takes the lock, `heavyReserveMb` or its measured peak (`needOf`). With
 * `--small` (a spec run, a lint) the step shares the host with other small steps instead, holding its measured peak or
 * `smallReserveMb`; a step without it waits for them to end. A small step is killed after `smallMaxRunMinutes`
 * instead, and its `--max-minutes` goes no higher. Once the shell that started it ends (Claude Code's
 * reaper ends a Bash tool's shell alone), it stops waiting for the lock, or kills its step and records exit 129, and
 * frees the lock. With `--pre-push` (a git pre-push hook's checks) it reuses their fresh pass on a clean tree, records
 * one when they pass, and declines a push whose checks waited past PRE_PUSH_MAX_WAIT_MS for the lock (push-pass.ts).
 * Exit 0 when the command passed, 1 when it failed, was killed or was stopped, 2 refused.
 */
export async function queue(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const words = commandWordsOf(args);
  const what = requiredFlag(args.flags, 'what');
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { delivery } = config;
  const zone = teamZone(config, runtime);
  const say = logLineOf(runtime, zone);
  const small = args.switches.has('small');
  const maxRunMinutes = maxRunMinutesOf(args, delivery.queue, small);
  const places = deliveryPlaces(delivery, kit.paths);
  const lock = hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom);
  const parent = await parentLockOf(runtime, lock, say);
  const session = await sessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), parent);
  const watching = await watchStarters(runtime, say);
  try {
    const step: Step = { what, words, maxRunMinutes, watching };
    const prePush: PrePush | undefined = args.switches.has('pre-push') ? { command: commandLine(words, runtime.platform), before: runtime.trees.checked(runtime.cwd) } : undefined;
    if (prePush !== undefined && (await reusedPass(runtime, say, prePush, zone))) {
      return EXIT.ok;
    }
    if (parent !== undefined) {
      const code = await runUnderParent(runtime, say, holderText({ kind: 'held', info: parent }, zone), step);
      return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, 0);
    }
    refuseAfterCutoff(runtime, delivery.schedule.queueCutoffUtc, zone);
    const queuedAt = runtime.clock.now();
    const need = await needOf(runtime, places.ledger, session, what, small, delivery.queue);
    const waiting = small ? 'waiting to share the host' : 'waiting for the host lock';
    const taking = await unlessStopped(
      watching.stop,
      lock.acquire(
        session,
        `heavy: ${what}`,
        delivery.queue.waitMinutes * MINUTE_MS,
        delivery.wait.pollSeconds * 1_000,
        (holder, ahead) => say(`${waiting}: ${waitText(holder, ahead, zone)}`),
        need,
        watching.stop,
      ),
    );
    if (taking === undefined) {
      return stoppedWhileWaiting(runtime, say, watching);
    }
    if (taking.kind === 'busy') {
      throw new RefusedError(busyText(taking.holder, zone));
    }
    if (taking.kind === 'withdrawn') {
      throw new RefusedError(`withdrawn from the host lock's line (teamrig withdraw): ${what} did not run`);
    }
    const waitedMs = runtime.clock.now() - queuedAt;
    try {
      refuseAfterCutoff(runtime, delivery.schedule.queueCutoffUtc, zone);
      const sharing = sharingText(need.reserveMb, taking);
      if (sharing !== undefined) {
        say(sharing);
      }
      say(`running: ${what} (killed after ${minutesText(maxRunMinutes)})`);
      const request = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: underLock(runtime.env, taking.lock), timeoutMs: maxRunMinutes * MINUTE_MS, stop: watching.stop };
      const mark = { session, what, queuedAt, ...(taking.sharing === undefined ? {} : { shared: true as const }), request };
      const end = await runRecorded(runtime, places.ledger, mark, watchOf(runtime, delivery.queue));
      const code = report(runtime, say, end, maxRunMinutes, watching);
      return prePush === undefined ? code : await afterPrePush(runtime, prePush, what, code, waitedMs);
    } finally {
      await lock.release(taking.lock);
    }
  } finally {
    watching.close();
  }
}
