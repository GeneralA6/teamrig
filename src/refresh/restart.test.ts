import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ProcessInfo } from '../open/session-processes.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { claudeProcessOf, GIVE_UP_MS, runRestart, type RestartDeps, type RestartPlan, type TabOpening } from './restart.ts';
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
const PLAN: RestartPlan = { id: 'alpha', at: AT, delayMs: DELAY_MS, endCommand: ['node', 'tracker.cjs', 'end'], fallbackCwd: '/project' };

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

class World {
  readonly files: MemoryFiles;
  readonly store: RefreshStore;
  readonly processes = new FakeSessionProcesses();
  readonly clock = new FakeClock(START);
  readonly deps: RestartDeps;
  /** When each new tab opened, in ms. */
  readonly opened: number[] = [];
  opening: TabOpening = { kind: 'opened' };
  /** Writes a transcript line during every wait, as a session at work. */
  busy = false;
  private readonly actions = new Map<number, () => Promise<void>>();
  private sleeps = 0;

  constructor(options: WorldOptions = {}) {
    this.files = new MemoryFiles({ [TRANSCRIPT]: options.transcript ?? `${JSON.stringify({ type: 'user' })}\n` });
    this.store = new RefreshStore(this.files, PATHS);
    (options.running ?? [TAB_SHELL, CLAUDE]).forEach((info) => this.processes.add(info));
    this.deps = {
      store: this.store,
      files: this.files,
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
    };
  }

  /** Runs `action` during the `n`th wait (1: the settle, 2: the first quiet window, ...). */
  onSleep(n: number, action: () => Promise<void>): this {
    this.actions.set(n, action);
    return this;
  }

  /** The Stop hook's work: the session waits for a fresh start and asked for this restart. */
  async arm(overrides: Partial<RestartRequest> = {}): Promise<this> {
    await this.store.setState('alpha', { phase: 'ready', task: 'T3', at: AT, noticed: true });
    await this.store.setRestart('alpha', {
      phase: 'pending',
      at: AT,
      pid: CLAUDE.pid,
      claudeSession: SESSION,
      transcript: TRANSCRIPT,
      cwd: '/project/sub',
      supervised: true,
      ...overrides,
    });
    return this;
  }
}

describe('runRestart', () => {
  it('ends a supervised session once it was quiet for the whole delay, leaves the request ending for launch, and runs the end command', async () => {
    const world = await new World().arm();
    const result = await runRestart(world.deps, PLAN);
    assert.deepEqual(result, { kind: 'restarted', where: 'same tab', endCommand: { kind: 'done' } });
    assert.equal(world.clock.now() - START, DELAY_MS);
    assert.deepEqual(world.processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal(world.processes.alive(TAB_SHELL.pid), true);
    assert.deepEqual(world.opened, []);
    assert.equal((await world.store.restart('alpha'))?.phase, 'ending');
    const [fed] = world.processes.fed;
    assert.ok(fed);
    assert.deepEqual([fed.command, fed.args, fed.cwd], ['node', ['tracker.cjs', 'end'], '/project/sub']);
    assert.deepEqual(JSON.parse(fed.input), { session_id: SESSION, transcript_path: TRANSCRIPT, cwd: '/project/sub', hook_event_name: 'SessionEnd', reason: 'clear' });
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
    const later = { phase: 'pending', at: '2030-01-08T10:00:05.000Z', pid: CLAUDE.pid, claudeSession: SESSION, transcript: TRANSCRIPT, cwd: null, supervised: true } as const;
    replaced.onSleep(2, () => replaced.store.setRestart('alpha', later));
    assert.equal((await runRestart(replaced.deps, PLAN)).kind, 'cancelled');
    assert.deepEqual(replaced.processes.ends, []);
    assert.deepEqual(await replaced.store.restart('alpha'), later);
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
    world.onSleep(2, () => world.files.append(TRANSCRIPT, `${JSON.stringify({ type: 'assistant' })}\n`));
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, 2 * DELAY_MS);
  });

  it('waits while background work runs, even with the transcript quiet', async () => {
    const world = await new World({ transcript: `${BACKGROUND_START.join('\n')}\n` }).arm();
    world.onSleep(4, () => world.files.append(TRANSCRIPT, `${BACKGROUND_END}\n`));
    assert.equal((await runRestart(world.deps, PLAN)).kind, 'restarted');
    assert.equal(world.clock.now() - START, 4 * DELAY_MS);
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
  });
});
