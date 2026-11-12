import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SHELL_RECHECK_MS } from '../open/end-tab.ts';
import type { ProcessInfo } from '../open/session-processes.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import type { EffortLevel } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { askFileOf, holdWhyFileOf, outcomeFileOf, type ClearMode } from '../mod/clear-hand.ts';
import { ClearAsks, type ClearAsk, type PostedClearAsk } from './clear-asks.ts';
import { CLAIM_WAIT_MS, claudeProcessOf, GIVE_UP_MS, LOOKUP_FAILED, NO_HOLD_REASON, personHoldOf, restartMayAct, runRestart, SILENT_MOD, type RestartDeps, type RestartPlan, type TabOpening } from './restart.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import type { RestartRequest } from './state.ts';
import { RefreshStore } from './store.ts';

const PATHS = { refresh: join('/', 'team', 'state', 'refresh'), handover: join('/', 'team', 'handover') };
const START = Date.parse('2030-01-08T10:00:00.000Z');
const AT = '2030-01-08T09:59:59.000Z';
const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const TRANSCRIPT = '/claude/projects/p/session.jsonl';
const DELAY_MS = 15_000;
const CLAUDE: ProcessInfo = { pid: 4100, parentPid: 4000, name: 'claude.exe', commandLine: `claude --resume ${SESSION}` };
const TAB_SHELL: ProcessInfo = { pid: 4000, parentPid: 1, name: 'powershell.exe', commandLine: `powershell -NoExit -Command claude --resume ${SESSION}` };
const ASK_DIR = '/kit/clear-asks';
/** Why the tab's mod holds an ask while its session runs a helper. */
const LIVE_HELPER = '1 agent of this session still live';
/** What a give-up says of a session that stayed busy. */
const BUSY_HOUR = 'it stayed busy for 60 minutes';
const PLAN: RestartPlan = { team: 'app', id: 'alpha', at: AT, delayMs: DELAY_MS, endCommand: ['node', 'tracker.cjs', 'end'], fallbackCwd: '/project', hold: { countdownMs: 20_000, afterActivityMs: 300_000 } };

/** What Claude Code writes once a turn has ended. */
const TURN_END = JSON.stringify({ type: 'system', subtype: 'turn_duration' });

/** A background command's start and its end, as Claude Code writes them to the transcript. */
const BACKGROUND_START = [
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} }] } }),
  JSON.stringify({
    type: 'user',
    timestamp: new Date(START).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'started' }] },
    toolUseResult: { stdout: '', backgroundTaskId: 'b1' },
  }),
];
const BACKGROUND_END = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_bash</tool-use-id>\n<status>completed</status>\n</task-notification>',
});

interface WorldOptions {
  readonly platform?: NodeJS.Platform;
  /** The running processes; default Claude Code in a PowerShell tab that resumed it. */
  readonly running?: readonly ProcessInfo[];
  readonly transcript?: string;
}

/** The session's entry in the restore registry, as its tracker left it in a turn. */
function restoreEntry(): RestoreEntry {
  return {
    claudeSession: SESSION,
    projectDir: '/project',
    transcriptPath: TRANSCRIPT,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: CLAUDE.pid,
    team: 'app',
    session: 'alpha',
    state: 'ready',
    createdAt: START,
    updatedAt: START,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
  };
}

class World {
  readonly files: MemoryFiles;
  readonly store: RefreshStore;
  readonly asks: ClearAsks;
  readonly processes = new FakeSessionProcesses();
  readonly clock = new FakeClock(START);
  readonly deps: RestartDeps;
  /** When each new tab opened, in ms. */
  readonly opened: number[] = [];
  opening: TabOpening = { kind: 'opened' };
  /** Writes a transcript line during every wait, as a session at work. */
  busy = false;
  /** The effort level the team config starts the session on; undefined: it sets none. */
  launchEffort: EffortLevel | undefined = undefined;
  /** The ask the tab's mod claimed. */
  claimed: ClearAsk | undefined;
  /** That ask's file as the restart wrote it, with what only the mod reads. */
  posted: unknown;
  private readonly actions = new Map<number, () => Promise<void>>();
  private sleeps = 0;

  constructor(options: WorldOptions = {}) {
    this.files = new MemoryFiles({ [TRANSCRIPT]: options.transcript ?? `${JSON.stringify({ type: 'assistant' })}\n${TURN_END}\n` });
    this.store = new RefreshStore(this.files, PATHS);
    this.asks = new ClearAsks(this.files, ASK_DIR);
    (options.running ?? [TAB_SHELL, CLAUDE]).forEach((info) => this.processes.add(info));
    this.deps = {
      store: this.store,
      files: this.files,
      asks: this.asks,
      restore: new RestoreRegistry(this.files, restoreSessionsDir(join('/', 'kit'))),
      processes: this.processes,
      clock: this.clock,
      sleep: async (ms) => {
        this.sleeps += 1;
        await this.actions.get(this.sleeps)?.();
        if (this.busy) {
          await this.files.append(TRANSCRIPT, `${JSON.stringify({ type: 'assistant', n: this.sleeps })}\n`);
        }
        await this.clock.sleep(ms);
      },
      platform: options.platform ?? 'win32',
      openTab: async () => {
        this.opened.push(this.clock.now());
        return this.opening;
      },
      launchEffort: async () => this.launchEffort,
    };
  }

  /** The tab's mod at work: claims the posted ask, as `hook clear-claim` does. */
  async claimAsk(): Promise<void> {
    this.claimed = await this.asks.ask(SESSION);
    assert.ok(this.claimed, 'an ask is posted');
    this.posted = JSON.parse(this.files.get(askFileOf(ASK_DIR, SESSION) ?? '') ?? '');
    assert.equal(await this.asks.claim(SESSION), true);
    await this.store.clearRestart('alpha');
  }

  /** The tab's mod while Claude Code lists a live helper: holds the posted ask, as `hook clear-claim --hold` does. */
  async holdAsk(): Promise<void> {
    assert.ok(await this.asks.ask(SESSION), 'an ask is posted');
    assert.equal(await this.asks.hold(SESSION, LIVE_HELPER), true);
  }

  /** The ask, its outcome and a hold's reason are gone once the runner is done. */
  asksClosed(): boolean {
    return [askFileOf, outcomeFileOf, holdWhyFileOf].every((fileOf) => this.files.get(fileOf(ASK_DIR, SESSION) ?? '') === undefined);
  }

  /** Runs `action` during the `n`th wait (1: the settle, 2: the first quiet window, 3 on: the waits for the tab's claim). */
  onSleep(n: number, action: () => Promise<void>): this {
    this.actions.set(n, action);
    return this;
  }

  /** The Stop hook's work: the session waits for a fresh start and asked for this restart. */
  async arm(overrides: Partial<RestartRequest> = {}): Promise<this> {
    await this.store.setState('alpha', { phase: 'ready', task: 'T3', at: AT, tokens: null, noticed: true, transcript: null, claudePid: null });
    await this.store.setRestart('alpha', {
      phase: 'pending',
      at: AT,
      pid: CLAUDE.pid,
      claudeSession: SESSION,
      transcript: TRANSCRIPT,
      cwd: '/project/sub',
      supervised: true,
      effort: null,
      ...overrides,
    });
    return this;
  }
}

/** Session processes during whose look at a process the user types: the prompt hook clears the request. */
class TypedWhileLooking extends FakeSessionProcesses {
  private readonly typed: () => Promise<void>;

  constructor(typed: () => Promise<void>) {
    super();
    this.typed = typed;
  }

  override async describe(pid: number): Promise<ProcessInfo | undefined> {
    await this.typed();
    return super.describe(pid);
  }
}

describe('restartMayAct', () => {
  const request: RestartRequest = { phase: 'pending', at: AT, pid: CLAUDE.pid, claudeSession: SESSION, transcript: TRANSCRIPT, cwd: null, supervised: false, effort: null };
  const asked = Date.parse(AT);

  it('holds for a request through the give-up and its last round, never for none or an older one', () => {
    assert.equal(restartMayAct(request, asked + GIVE_UP_MS), true);
    assert.equal(restartMayAct({ ...request, phase: 'ending' }, asked), true);
    assert.equal(restartMayAct(request, asked + GIVE_UP_MS + 10 * 60_000), false);
    assert.equal(restartMayAct(undefined, asked), false);
  });
});

describe('personHoldOf', () => {
  it("turns the team's countdown seconds and activity minutes into the ask's ms", () => {
    assert.deepEqual(personHoldOf({ countdownSeconds: 20, holdAfterActivityMinutes: 5 }), PLAN.hold);
    assert.deepEqual(personHoldOf({ countdownSeconds: 0, holdAfterActivityMinutes: 0 }), { countdownMs: 0, afterActivityMs: 0 }, 'both off');
  });
});

describe('runRestart', () => {
  it('ends a supervised session once it was quiet for the whole delay, leaves the request ending for launch, and runs the end command', async () => {
    const world = await new World().arm();
    const result = await runRestart(world.deps, PLAN);
    assert.deepEqual(result, { kind: 'restarted', where: 'same tab', endCommand: { kind: 'done' } });
    assert.equal(world.clock.now() - START, DELAY_MS + CLAIM_WAIT_MS, 'the tab had the whole wait to claim the ask');
    assert.ok(world.asksClosed());
    assert.deepEqual(world.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal(world.processes.alive(TAB_SHELL.pid), true);
    assert.deepEqual(world.opened, []);
    assert.equal((await world.store.restart('alpha'))?.phase, 'ending');
    const [fed] = world.processes.fed;
    assert.ok(fed);
    assert.deepEqual([fed.command, fed.args, fed.cwd], ['node', ['tracker.cjs', 'end'], '/project/sub']);
    assert.deepEqual(JSON.parse(fed.input), { session_id: SESSION, transcript_path: TRANSCRIPT, cwd: '/project/sub', hook_event_name: 'SessionEnd', reason: 'clear' });
  });

  it('takes the ended session out of the restore registry, as its skipped SessionEnd hook would', async () => {
    for (const supervised of [true, false]) {
      const world = await new World().arm({ supervised });
      await world.deps.restore.write(restoreEntry());
      assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
      assert.equal(await world.deps.restore.read(SESSION), undefined);
    }
  });

  it('keeps the session in the restore registry when no restart happened', async () => {
    const world = await new World().arm({ supervised: false });
    world.opening = { kind: 'none', reasons: ['no terminal'] };
    await world.deps.restore.write(restoreEntry());
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'failed');
    assert.equal((await world.deps.restore.read(SESSION))?.claudeSession, SESSION);
  });

  it('opens the fresh tab first, then closes the old one by ending the shell it runs in (Windows)', async () => {
    const world = await new World().arm({ supervised: false });
    const tabsWhenEnded: number[] = [];
    world.processes.whenEnded(() => tabsWhenEnded.push(world.opened.length));
    const result = await runRestart(world.deps, PLAN);
    assert.deepEqual(result, { kind: 'restarted', where: 'new tab', endCommand: { kind: 'done' } });
    assert.deepEqual(world.processes.ends, [{ pid: TAB_SHELL.pid, how: 'ask' }]);
    assert.deepEqual(tabsWhenEnded, [1, 1]);
    assert.equal(world.processes.alive(CLAUDE.pid), false);
    assert.equal(await world.store.restart('alpha'), undefined);
    assert.equal(world.processes.fed.length, 1);
  });

  it('ends Claude Code itself off Windows, or when its parent is not a shell started for it', async () => {
    const linux = await new World({ platform: 'linux' }).arm({ supervised: false });
    await runRestart(linux.deps, PLAN);
    assert.deepEqual(linux.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal(linux.processes.alive(TAB_SHELL.pid), true);
    const terminal: ProcessInfo = { pid: 4000, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt' };
    const windows = await new World({ running: [terminal, CLAUDE] }).arm({ supervised: false });
    await runRestart(windows.deps, PLAN);
    assert.deepEqual(windows.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal(windows.processes.alive(terminal.pid), true);
  });

  it('ends nothing when no new tab opens, and says why', async () => {
    const world = await new World().arm({ supervised: false });
    world.opening = { kind: 'none', reasons: ['no terminal found', 'tmux is not running'] };
    const result = await runRestart(world.deps, PLAN);
    assert.deepEqual(result, { kind: 'failed', why: 'no new tab opened (no terminal found; tmux is not running)' });
    assert.deepEqual(world.processes.ends, []);
    assert.equal(world.processes.alive(CLAUDE.pid), true);
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('stops without acting once the user typed (the request is gone) or a later restart replaced it', async () => {
    const typed = await new World().arm();
    typed.onSleep(2, () => typed.store.clearRestart('alpha'));
    assert.deepEqual(await runRestart(typed.deps, PLAN), { kind: 'cancelled', why: 'the restart was cancelled or replaced' });
    assert.deepEqual(typed.processes.ends, []);
    const replaced = await new World().arm();
    const later = { phase: 'pending', at: '2030-01-08T10:00:05.000Z', pid: CLAUDE.pid, claudeSession: SESSION, transcript: TRANSCRIPT, cwd: null, supervised: true, effort: null } as const;
    replaced.onSleep(2, () => replaced.store.setRestart('alpha', later));
    assert.equal((await runRestart(replaced.deps, PLAN)).kind, 'cancelled');
    assert.deepEqual(replaced.processes.ends, []);
    assert.deepEqual(await replaced.store.restart('alpha'), later);
  });

  it('stops without ending anything when the user types while it looks at the process', async () => {
    const world = await new World().arm();
    const typing = new TypedWhileLooking(() => world.store.clearRestart('alpha'));
    typing.add(TAB_SHELL).add(CLAUDE);
    assert.deepEqual(await runRestart({ ...world.deps, processes: typing }, PLAN), { kind: 'cancelled', why: 'the restart was cancelled or replaced' });
    assert.deepEqual([typing.ends, typing.fed], [[], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('does nothing when no restart is pending', async () => {
    const world = new World();
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cancelled', why: 'no restart is pending' });
    assert.deepEqual(world.processes.ends, []);
  });

  it('cancels and clears the request when the session was refreshed by hand meanwhile', async () => {
    const world = await new World().arm();
    world.onSleep(2, () => world.store.setState('alpha', { phase: 'refreshed', task: 'T3', at: AT }));
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cancelled', why: 'the session was refreshed another way' });
    assert.deepEqual(world.processes.ends, []);
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('waits while the transcript grows, and restarts after a whole quiet delay', async () => {
    const world = await new World().arm();
    world.onSleep(2, () => world.files.append(TRANSCRIPT, `${JSON.stringify({ type: 'assistant' })}\n${TURN_END}\n`));
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, 2 * DELAY_MS + CLAIM_WAIT_MS);
  });

  it('waits while background work runs, even with the transcript quiet', async () => {
    const world = await new World({ transcript: `${[...BACKGROUND_START, TURN_END].join('\n')}\n` }).arm();
    world.onSleep(4, () => world.files.append(TRANSCRIPT, `${BACKGROUND_END}\n`));
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, 4 * DELAY_MS + CLAIM_WAIT_MS);
  });

  it('waits while a turn runs, even with the transcript quiet, as during a long foreground command', async () => {
    const command = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: {} }] } });
    const world = await new World({ transcript: `${command}\n` }).arm();
    const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_long', content: 'done' }] } });
    world.onSleep(4, () => world.files.append(TRANSCRIPT, `${result}\n${JSON.stringify({ type: 'assistant' })}\n${TURN_END}\n`));
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, 4 * DELAY_MS + CLAIM_WAIT_MS);
  });

  it('gives up after an hour of work, keeping the context', async () => {
    const world = await new World().arm();
    world.busy = true;
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'failed', why: 'it stayed busy for 60 minutes' });
    assert.ok(world.clock.now() - START >= GIVE_UP_MS);
    assert.deepEqual(world.processes.ends, []);
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('refuses to end a process that is not Claude Code, and counts Node.js running its script as Claude Code', async () => {
    const notepad: ProcessInfo = { ...CLAUDE, name: 'notepad.exe', commandLine: 'notepad' };
    const other = await new World({ running: [notepad] }).arm();
    assert.deepEqual(await runRestart(other.deps, PLAN), { kind: 'failed', why: 'process 4100 is notepad.exe, not Claude Code' });
    assert.deepEqual(other.processes.ends, []);
    const node: ProcessInfo = { ...CLAUDE, name: 'node.exe', commandLine: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' };
    const script = await new World({ running: [node] }).arm();
    assert.equal((await runRestart(script.deps, PLAN)).kind, 'restarted');
  });

  it('cancels when its Claude Code has already ended', async () => {
    const world = await new World({ running: [] }).arm();
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cancelled', why: 'its Claude Code has already ended' });
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('looks again after the next quiet window when the system would not describe its running Claude Code (T980)', async () => {
    const world = await new World().arm();
    world.processes.failLookups(1);
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'restarted', where: 'same tab', endCommand: { kind: 'done' } });
    assert.equal(world.clock.now() - START, 2 * DELAY_MS + CLAIM_WAIT_MS, 'one more quiet window before the second look');
    assert.deepEqual(world.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
  });

  it('gives up at the hour, ending nothing, when every look at its running Claude Code fails', async () => {
    const world = await new World().arm();
    world.processes.failLookups(Number.POSITIVE_INFINITY);
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'failed', why: `${BUSY_HOUR} (${LOOKUP_FAILED} ${CLAUDE.pid})` });
    const ran = world.clock.now() - START;
    assert.ok(ran >= GIVE_UP_MS && ran < GIVE_UP_MS + DELAY_MS, `gave up at ${ran} ms`);
    assert.deepEqual([world.processes.ends, world.opened], [[], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it('forces an end the process ignores, and fails when ending fails', async () => {
    const lingering = await new World().arm();
    lingering.processes.linger(CLAUDE.pid);
    assert.equal((await runRestart(lingering.deps, PLAN)).kind, 'restarted');
    assert.deepEqual(lingering.processes.ends, [
      { pid: CLAUDE.pid, how: 'ask' },
      { pid: CLAUDE.pid, how: 'force' },
    ]);
    const refused = await new World().arm();
    refused.processes.failEnd(CLAUDE.pid, 'access denied');
    assert.deepEqual(await runRestart(refused.deps, PLAN), { kind: 'failed', why: 'could not end process 4100: access denied' });
    assert.equal(await refused.store.restart('alpha'), undefined);
  });

  it('runs no end command when none is set, and passes on how a set one went', async () => {
    const none = await new World().arm();
    assert.deepEqual(await runRestart(none.deps, { ...PLAN, endCommand: [] }), { kind: 'restarted', where: 'same tab', endCommand: undefined });
    assert.deepEqual(none.processes.fed, []);
    const failing = await new World().arm({ cwd: null });
    failing.processes.onFeed('node', { kind: 'failed', error: 'exit code 1' });
    const result = await runRestart(failing.deps, PLAN);
    assert.deepEqual(result, { kind: 'restarted', where: 'same tab', endCommand: { kind: 'failed', error: 'exit code 1' } });
    assert.equal(failing.processes.fed[0]?.cwd, '/project');
  });

  it('fails without a transcript, since it cannot tell when the session is idle', async () => {
    const world = await new World().arm({ transcript: null });
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'failed');
    assert.deepEqual(world.processes.ends, []);
    assert.equal(await world.store.restart('alpha'), undefined);
  });
});

/** Asks whose claim lands between the runner's last look and its withdraw. */
class ClaimedAtWithdraw extends ClearAsks {
  override async withdraw(claudeSession: string): Promise<boolean> {
    await this.claim(claudeSession);
    return super.withdraw(claudeSession);
  }
}

describe("runRestart through the tab's mod", () => {
  it('leaves the session to its tab once the mod claims the ask: nothing is ended, opened or run', async () => {
    const world = await new World().arm();
    world.onSleep(3, () => world.claimAsk());
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cleared' });
    assert.deepEqual(world.claimed, { team: 'app', id: 'alpha', at: AT, askedAt: new Date(START + DELAY_MS).toISOString(), mode: 'clear' });
    assert.deepEqual(world.posted, { ...world.claimed, hold: PLAN.hold, askEveryMs: DELAY_MS }, "the file carries the plan's hold and delay, for the tab's mod");
    assert.deepEqual([world.processes.ends, world.opened, world.processes.fed], [[], [], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
    assert.equal((await world.store.state('alpha'))?.phase, 'ready', "the SessionStart clear hook takes the refresh, not the runner");
    assert.ok(world.asksClosed());
  });

  it('clears the request itself when the claim won but stopped before clearing it', async () => {
    const world = await new World().arm();
    world.onSleep(3, async () => {
      await world.asks.claim(SESSION);
    });
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cleared' });
    assert.equal(await world.store.restart('alpha'), undefined);
  });

  it("counts a claim that lands just before its withdraw as the tab's", async () => {
    const world = await new World().arm();
    const asks = new ClaimedAtWithdraw(world.files, ASK_DIR);
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'cleared' });
    assert.deepEqual(world.processes.ends, []);
    assert.equal(await world.store.restart('alpha'), undefined);
    assert.ok(world.asksClosed());
  });

  it('stops without acting when the user types while it waits for the claim', async () => {
    const world = await new World().arm();
    world.onSleep(5, () => world.store.clearRestart('alpha'));
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cancelled', why: 'the restart was cancelled or replaced' });
    assert.deepEqual([world.processes.ends, world.opened], [[], []]);
    assert.ok(world.clock.now() - START < DELAY_MS + CLAIM_WAIT_MS, 'it stopped at once');
    assert.ok(world.asksClosed());
  });

  it('waits for quiet and asks again when a turn ran while it waited for the claim', async () => {
    const command = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wake', name: 'Bash', input: {} }] } });
    const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wake', content: 'done' }] } });
    const world = await new World().arm();
    // Waits 3-22 are for the first claim; 23 settles, 24 and 25 are quiet windows; 26 is for the second claim.
    world.onSleep(3, () => world.files.append(TRANSCRIPT, `${command}
`));
    world.onSleep(24, () => world.files.append(TRANSCRIPT, `${result}
${JSON.stringify({ type: 'assistant' })}
${TURN_END}
`));
    world.onSleep(26, () => world.claimAsk());
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cleared' });
    assert.equal(world.claimed?.askedAt, new Date(START + DELAY_MS + CLAIM_WAIT_MS + 2 * DELAY_MS).toISOString(), 'the second ask');
    assert.deepEqual(world.processes.ends, []);
  });

  it('ends the session with no ask when its session id cannot name a file', async () => {
    const world = await new World().arm({ claudeSession: '../escape' });
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, DELAY_MS, 'no wait for a claim');
  });
});

/**
 * Asks the tab's mod claims as soon as they are posted, as `hook clear-claim` does: an `end` ask with `--end`, else
 * for its /clear, which clears the request (`cleared` runs). An older mod (`withEnd` false) never passes `--end`.
 */
class ClaimedByMod extends ClearAsks {
  /** The mode of each ask posted, in order. */
  readonly modes: ClearMode[] = [];
  private readonly withEnd: boolean;
  private readonly cleared: () => Promise<void>;

  constructor(files: Files, dir: string, withEnd: boolean, cleared: () => Promise<void>) {
    super(files, dir);
    this.withEnd = withEnd;
    this.cleared = cleared;
  }

  override async post(claudeSession: string, ask: PostedClearAsk): Promise<void> {
    await super.post(claudeSession, ask);
    this.modes.push(ask.mode);
    if (ask.mode === 'end' && this.withEnd) {
      assert.equal(await this.claimEnd(claudeSession), true);
      return;
    }
    assert.equal(await this.claim(claudeSession), true);
    await this.cleared();
  }
}

/** The transcript lines of a `/effort <level>` the user typed at `at`, and Claude Code's reply. */
function typedEffort(at: string, level: EffortLevel): string {
  const uuid = `effort-${at}`;
  const entry = { type: 'user', isSidechain: false, sessionId: SESSION, timestamp: at };
  return [
    JSON.stringify({ ...entry, uuid, message: { role: 'user', content: `<command-name>/effort</command-name>\n<command-args>${level}</command-args>` } }),
    JSON.stringify({ ...entry, uuid: `${uuid}-reply`, parentUuid: uuid, message: { role: 'user', content: `<local-command-stdout>Set effort level to ${level}</local-command-stdout>` } }),
  ].join('\n');
}

/** A quiet transcript in which the user typed `/effort <level>` at `at`. */
function transcriptTyped(at: string, level: EffortLevel): string {
  return `${typedEffort(at, level)}\n${JSON.stringify({ type: 'assistant' })}\n${TURN_END}\n`;
}

describe("runRestart when the session runs at another effort level than its config's", () => {
  /** A world whose last turn ran at `running` and whose config starts the session at `wanted`, its tab's mod claiming each ask. */
  async function worldOf(running: EffortLevel | null, wanted: EffortLevel | undefined, options: WorldOptions & { readonly supervised?: boolean; readonly withEnd?: boolean } = {}): Promise<{ readonly world: World; readonly asks: ClaimedByMod }> {
    const world = await new World(options).arm({ effort: running, supervised: options.supervised ?? true });
    world.launchEffort = wanted;
    const asks = new ClaimedByMod(world.files, ASK_DIR, options.withEnd ?? true, () => world.store.clearRestart('alpha'));
    return { world, asks };
  }

  it("asks the tab to end the session, and once claimed ends it for launch to start it at the config's level", async () => {
    const { world, asks } = await worldOf('xhigh', 'medium');
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'restarted', where: 'same tab', endCommand: { kind: 'done' } });
    assert.deepEqual(asks.modes, ['end']);
    assert.deepEqual(world.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal((await world.store.restart('alpha'))?.phase, 'ending', 'launch starts it again');
    assert.equal(world.clock.now() - START, DELAY_MS + 500, 'ended at the claim, not after the whole wait for one');
    assert.ok(world.asksClosed());
  });

  it('opens a new tab before it ends a session not under launch', async () => {
    const { world, asks } = await worldOf('xhigh', 'medium', { supervised: false });
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'restarted', where: 'new tab', endCommand: { kind: 'done' } });
    assert.equal(world.opened.length, 1);
  });

  it('asks for a /clear when the levels match, or either is unknown', async () => {
    for (const [running, wanted] of [['medium', 'medium'], [null, 'medium'], ['xhigh', undefined]] as const) {
      const { world, asks } = await worldOf(running, wanted);
      assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'cleared' }, `${running} against ${wanted}`);
      assert.deepEqual([asks.modes, world.processes.ends], [['clear'], []]);
    }
  });

  it('takes the level of a /effort typed after the request as the running one, and not one typed before it', async () => {
    const after = new Date(Date.parse(AT) + 1_000).toISOString();
    const typed = await worldOf('xhigh', 'medium', { transcript: transcriptTyped(after, 'medium') });
    assert.deepEqual(await runRestart({ ...typed.world.deps, asks: typed.asks }, PLAN), { kind: 'cleared' });
    assert.deepEqual(typed.asks.modes, ['clear']);
    const before = new Date(Date.parse(AT) - 60_000).toISOString();
    const older = await worldOf('xhigh', 'medium', { transcript: transcriptTyped(before, 'medium') });
    assert.equal((await runRestart({ ...older.world.deps, asks: older.asks }, PLAN)).kind, 'restarted');
    assert.deepEqual(older.asks.modes, ['end'], 'the turn after it ran at the request level');
  });

  it('asks for a /clear, which keeps them, while Claude Code runs a background shell', async () => {
    const shell: ProcessInfo = { pid: 4200, parentPid: CLAUDE.pid, name: 'bash.exe', commandLine: 'bash -c "npm run nightly"' };
    const { world, asks } = await worldOf('xhigh', 'medium', { running: [TAB_SHELL, CLAUDE, shell] });
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'cleared' });
    assert.deepEqual([asks.modes, world.processes.ends], [['clear'], []]);
  });

  it("counts an older mod's claim of an end ask as its /clear: nothing is ended", async () => {
    const { world, asks } = await worldOf('xhigh', 'medium', { withEnd: false });
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'cleared' });
    assert.deepEqual([asks.modes, world.processes.ends, world.opened], [['end'], [], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
  });
});

/** Asks the tab's mod holds as soon as they are posted, for `why` (undefined: an older mod's hold, with none). */
class HeldByTab extends ClearAsks {
  private readonly why: string | undefined;

  constructor(files: Files, dir: string, why: string | undefined) {
    super(files, dir);
    this.why = why;
  }

  override async post(claudeSession: string, ask: PostedClearAsk): Promise<void> {
    await super.post(claudeSession, ask);
    await this.hold(claudeSession, this.why);
  }
}

/** Asks whose first hold lands between the runner's last look and its withdraw; later asks go unanswered. */
class HeldAtFirstWithdraw extends ClearAsks {
  withdraws = 0;

  override async withdraw(claudeSession: string): Promise<boolean> {
    this.withdraws += 1;
    if (this.withdraws === 1) {
      await this.hold(claudeSession, LIVE_HELPER);
    }
    return super.withdraw(claudeSession);
  }
}

describe('runRestart while the tab holds its ask (a helper still runs)', () => {
  it('ends nothing on a held answer, though the transcript looks idle, and clears once the tab claims a later ask', async () => {
    const world = await new World().arm({ supervised: false });
    // Wait 3 is the first look for the tab's answer; 4 settles, 5 is the quiet window; 6 is the look for the second answer.
    world.onSleep(3, () => world.holdAsk());
    world.onSleep(6, () => world.claimAsk());
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cleared' });
    assert.equal(world.claimed?.askedAt, new Date(START + 2 * DELAY_MS + 500).toISOString(), 'the second ask, a whole quiet delay after the hold');
    assert.deepEqual([world.processes.ends, world.opened, world.processes.fed], [[], [], []]);
    assert.ok(world.asksClosed());
  });

  it('keeps the request pending between held rounds, so a prompt typed then still cancels', async () => {
    const world = await new World().arm();
    world.onSleep(3, () => world.holdAsk());
    world.onSleep(5, () => world.store.clearRestart('alpha'));
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'cancelled', why: 'the restart was cancelled or replaced' });
    assert.deepEqual([world.processes.ends, world.opened], [[], []]);
  });

  it('counts a hold that lands just before its withdraw as the tab\'s: nothing is ended that round', async () => {
    const world = await new World().arm();
    const asks = new HeldAtFirstWithdraw(world.files, ASK_DIR);
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'failed', why: `${BUSY_HOUR} (${SILENT_MOD})` });
    assert.ok(asks.withdraws >= 2, 'the held round asked again');
    assert.deepEqual(world.processes.ends, []);
  });

  it('never ends a tab whose mod held an ask and then fell silent, as after a /reload-plugins (T2544): it gives up at the hour', async () => {
    const world = await new World().arm({ supervised: false });
    // Wait 3 is the first look for the tab's answer: held for the person; every later ask goes unanswered.
    world.onSleep(3, () => world.holdAsk());
    assert.deepEqual(await runRestart(world.deps, PLAN), { kind: 'failed', why: `${BUSY_HOUR} (${SILENT_MOD})` });
    assert.deepEqual([world.processes.ends, world.opened, world.processes.fed], [[], [], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
    assert.ok(world.asksClosed());
  });

  it('gives up after an hour of held asks the way it does for a busy session: nothing ended, the context kept', async () => {
    const world = await new World().arm({ supervised: false });
    const asks = new HeldByTab(world.files, ASK_DIR, LIVE_HELPER);
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'failed', why: `${BUSY_HOUR} (its tab last held the /clear: ${LIVE_HELPER})` });
    const ran = world.clock.now() - START;
    assert.ok(ran >= GIVE_UP_MS && ran < GIVE_UP_MS + DELAY_MS + CLAIM_WAIT_MS, `gave up at ${ran} ms`);
    assert.deepEqual([world.processes.ends, world.opened, world.processes.fed], [[], [], []]);
    assert.equal(await world.store.restart('alpha'), undefined);
    assert.ok(world.asksClosed());
  });

  it("names the hold of a mod that gave no reason (an older one's) when it gives up", async () => {
    const world = await new World().arm({ supervised: false });
    const asks = new HeldByTab(world.files, ASK_DIR, undefined);
    assert.deepEqual(await runRestart({ ...world.deps, asks }, PLAN), { kind: 'failed', why: `${BUSY_HOUR} (its tab last held the /clear: ${NO_HOLD_REASON})` });
    assert.deepEqual(world.processes.ends, []);
  });

  it('counts the hour from the run\'s start across held rounds, not from each round', async () => {
    const world = await new World().arm();
    const asks = new HeldByTab(world.files, ASK_DIR, LIVE_HELPER);
    // Held for 50 minutes, then busy: still gives up at the hour.
    let held = true;
    const busyAfter = START + 50 * 60_000;
    const deps: RestartDeps = {
      ...world.deps,
      asks,
      sleep: async (ms) => {
        if (held && world.clock.now() >= busyAfter) {
          held = false;
          world.busy = true;
        }
        await world.deps.sleep(ms);
      },
    };
    assert.deepEqual(await runRestart(deps, PLAN), { kind: 'failed', why: BUSY_HOUR }, 'busy at the hour, not held: no hold reason');
    assert.ok(world.clock.now() - START < GIVE_UP_MS + 2 * DELAY_MS);
    assert.deepEqual(world.processes.ends, []);
  });
});

describe('runRestart with shells under its Claude Code', () => {
  /** A background command's shell, as Claude Code starts it: ending Claude Code's tree would end it. */
  const SHELL: ProcessInfo = { pid: 4200, parentPid: CLAUDE.pid, name: 'bash.exe', commandLine: 'bash -c "source snapshot.sh && npm run nightly"' };
  const UNLISTED = { kind: 'failed', why: 'teamrig could not list what its Claude Code (4100) runs' };

  it('ends nothing while Claude Code runs a background shell, in its own tab or not, and says why', async () => {
    for (const supervised of [true, false]) {
      const world = await new World({ running: [TAB_SHELL, CLAUDE, SHELL] }).arm({ supervised });
      const result = await runRestart(world.deps, PLAN);
      assert.deepEqual(result, { kind: 'failed', why: 'ending its Claude Code would also end the background shells it runs (pid 4200)' });
      assert.equal(world.clock.now() - START, DELAY_MS + CLAIM_WAIT_MS + SHELL_RECHECK_MS, 'it looked twice');
      assert.deepEqual(world.processes.ends, []);
      assert.deepEqual(world.opened, [], 'no new tab either');
      assert.deepEqual(world.processes.fed, []);
      assert.equal(await world.store.restart('alpha'), undefined);
    }
    const login: ProcessInfo = { pid: 4200, parentPid: CLAUDE.pid, name: '-zsh', commandLine: '-zsh' };
    const linux = await new World({ platform: 'linux', running: [TAB_SHELL, CLAUDE, login] }).arm();
    assert.equal((await runRestart(linux.deps, PLAN)).kind, 'failed');
  });

  it('ends the session when the shell it saw is gone a moment later, as a status line command, even with a new one', async () => {
    const world = await new World({ running: [TAB_SHELL, CLAUDE, SHELL] }).arm();
    // Waits 3-22 are for the claim; 23 is the second look.
    world.onSleep(23, async () => {
      world.processes.exit(SHELL.pid).add({ ...SHELL, pid: 4300 });
    });
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.deepEqual(world.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
  });

  it('stops without ending anything when the user types during the second look', async () => {
    const world = await new World({ running: [TAB_SHELL, CLAUDE, SHELL] }).arm();
    world.onSleep(23, async () => {
      world.processes.exit(SHELL.pid);
      await world.store.clearRestart('alpha');
    });
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'cancelled');
    assert.deepEqual(world.processes.ends, []);
  });

  it('ends nothing when the system will not list what Claude Code runs, at either look', async () => {
    const hidden = await new World().arm();
    hidden.processes.hideChildren();
    assert.deepEqual(await runRestart(hidden.deps, PLAN), UNLISTED);
    assert.deepEqual(hidden.processes.ends, []);
    const later = await new World({ running: [TAB_SHELL, CLAUDE, SHELL] }).arm();
    later.onSleep(23, async () => {
      later.processes.hideChildren();
    });
    assert.deepEqual(await runRestart(later.deps, PLAN), UNLISTED);
    assert.deepEqual(later.processes.ends, []);
  });

  it('is not held by what is no command shell: an MCP server, cmd, or a shell another child started', async () => {
    const mcp: ProcessInfo = { pid: 4201, parentPid: CLAUDE.pid, name: 'node.exe', commandLine: 'node mcp.js' };
    const cmd: ProcessInfo = { pid: 4202, parentPid: CLAUDE.pid, name: 'cmd.exe', commandLine: 'cmd /c npx server' };
    const deeper: ProcessInfo = { pid: 4203, parentPid: mcp.pid, name: 'bash.exe', commandLine: 'bash' };
    const world = await new World({ running: [TAB_SHELL, CLAUDE, mcp, cmd, deeper] }).arm();
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, DELAY_MS + CLAIM_WAIT_MS, 'no second look');
  });
});

describe('claudeProcessOf', () => {
  const process = (pid: number, parentPid: number, name: string, commandLine: string): ProcessInfo => ({ pid, parentPid, name, commandLine });

  it('finds the Claude Code a hook runs under: its parent, or past a shell between', async () => {
    const processes = new FakeSessionProcesses()
      .add(process(10, 1, 'claude.exe', 'claude'))
      .add(process(11, 10, 'bash.exe', 'bash -c "node main.js hook stop"'))
      .add(process(20, 1, 'node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'));
    assert.equal(await claudeProcessOf(processes, 10), 10);
    assert.equal(await claudeProcessOf(processes, 11), 10);
    assert.equal(await claudeProcessOf(processes, 20), 20, 'Claude Code run by Node.js');
    assert.deepEqual([processes.described, processes.lineages], [[], [10, 11, 20]], 'one listing per look');
  });

  it('finds none when a process is gone, or Claude Code is further up than a hook would be', async () => {
    const processes = new FakeSessionProcesses()
      .add(process(30, 31, 'bash', 'bash'))
      .add(process(31, 32, 'bash', 'bash'))
      .add(process(32, 33, 'bash', 'bash'))
      .add(process(33, 1, 'claude', 'claude'));
    assert.equal(await claudeProcessOf(processes, 31), 33);
    assert.equal(await claudeProcessOf(processes, 30), undefined, 'three parents up');
    assert.equal(await claudeProcessOf(processes, 99), undefined, 'gone');
    assert.equal(await claudeProcessOf(new FakeSessionProcesses().add(process(40, 41, 'bash', 'bash')), 40), undefined, 'its parent is gone');
    assert.equal(await claudeProcessOf(processes.hideLineage(), 33), undefined, 'the system would not list the processes');
  });
});
