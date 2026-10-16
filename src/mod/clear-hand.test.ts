import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { askFileOf, ClearHand, DIR_RETRY_MS, isClaudeSessionId, liveAgentsOf, outcomeFileOf, type ClearHandHost, type CliRun } from './clear-hand.ts';

const DIR = '/kit/clear-asks';
const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const ASK = '{"team":"app","id":"alpha","at":"2030-01-08T09:59:59.000Z","askedAt":"2030-01-08T10:00:15.000Z"}\n';
const NEXT_ASK = '{"team":"app","id":"alpha","at":"2030-01-08T09:59:59.000Z","askedAt":"2030-01-08T10:01:00.000Z"}\n';

interface CliCall {
  readonly args: readonly string[];
  readonly stdin: string;
}

/** Claude Code as the mod sees it: one tab's session, its files and the teamrig CLI. */
class FakeHost implements ClearHandHost {
  session = SESSION;
  time = 0;
  readonly files = new Map<string, string>();
  readonly calls: CliCall[] = [];
  clears = 0;
  dirRun: CliRun | Error = { exitCode: 0, stdout: `${DIR}\n` };
  claimRun: CliRun = { exitCode: 0, stdout: 'taken\n' };
  holdRun: CliRun = { exitCode: 0, stdout: 'held\n' };
  /** The session's live agents as Claude Code lists them, or why the list failed. */
  live: number | Error = 0;
  agentLists = 0;
  /** Thrown by `read`, as a file the mod cannot read. */
  readFailure: unknown;
  /** Holds each /clear until it resolves, as a /clear waits for a turn in progress. */
  clearing: Promise<void> = Promise.resolve();

  async sessionId(): Promise<string> {
    return this.session;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    if (this.readFailure !== undefined) {
      throw this.readFailure;
    }
    return this.files.get(path) ?? '';
  }

  async cli(args: readonly string[], stdin: string): Promise<CliRun> {
    this.calls.push({ args, stdin });
    if (args[1] !== 'clear-dir') {
      return args.includes('--hold') ? this.holdRun : this.claimRun;
    }
    if (this.dirRun instanceof Error) {
      throw this.dirRun;
    }
    return this.dirRun;
  }

  async liveAgents(): Promise<number> {
    this.agentLists += 1;
    if (this.live instanceof Error) {
      throw this.live;
    }
    return this.live;
  }

  async clear(): Promise<void> {
    this.clears += 1;
    await this.clearing;
  }

  now(): number {
    return this.time;
  }

  /** The runner's ask for this tab. */
  ask(text: string = ASK): void {
    this.files.set(`${DIR}/${this.session}.ask`, text);
  }

  claims(): readonly CliCall[] {
    return this.calls.filter((call) => call.args[1] === 'clear-claim');
  }
}

describe('ClearHand', () => {
  it('claims a new ask while no turn runs, then runs /clear, once per ask', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'no ask' });
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
    assert.equal(host.clears, 1);
    assert.deepEqual(host.calls, [
      { args: ['hook', 'clear-dir'], stdin: '' },
      { args: ['hook', 'clear-claim'], stdin: JSON.stringify({ session_id: SESSION }) },
    ]);
    assert.deepEqual(await hand.tick(), { kind: 'no ask' }, 'the same ask again');
    assert.equal(host.clears, 1);
  });

  it('leaves an ask that comes during a turn, and acts on the next one', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.ask();
    hand.turnStarted();
    assert.deepEqual(await hand.tick(), { kind: 'busy' });
    hand.turnEnded();
    assert.deepEqual(await hand.tick(), { kind: 'no ask' }, 'the runner takes that ask back and asks again once quiet');
    assert.deepEqual(host.claims(), []);
    host.ask(NEXT_ASK);
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
  });

  it('runs no /clear when the claim is declined, and passes on why', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.claimRun = { exitCode: 0, stdout: 'declined: the restart is no longer pending\n' };
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'declined: the restart is no longer pending' });
    host.claimRun = { exitCode: 1, stdout: '' };
    host.ask(NEXT_ASK);
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'exit 1' });
    host.claimRun = { exitCode: 2, stdout: 'taken' };
    host.ask(ASK);
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'taken' }, 'a failed run is never a claim');
    assert.equal(host.clears, 0);
  });

  it('holds the ask while Claude Code lists a live agent of the session, running no /clear, and claims once none is', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.live = 2;
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'held', why: '2 agents of this session still live' });
    assert.deepEqual(host.claims(), [{ args: ['hook', 'clear-claim', '--hold'], stdin: JSON.stringify({ session_id: SESSION }) }]);
    assert.equal(host.clears, 0);
    assert.deepEqual(await hand.tick(), { kind: 'no ask' }, 'the held ask is not held twice');
    host.live = 1;
    host.ask(NEXT_ASK);
    assert.deepEqual(await hand.tick(), { kind: 'held', why: '1 agent of this session still live' });
    host.live = 0;
    host.ask(ASK);
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
    assert.deepEqual(
      host.claims().map((call) => call.args),
      [
        ['hook', 'clear-claim', '--hold'],
        ['hook', 'clear-claim', '--hold'],
        ['hook', 'clear-claim'],
      ],
    );
    assert.equal(host.clears, 1);
  });

  it('holds the ask when Claude Code will not list the agents, and says why', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.live = new Error('agent.list is not a function');
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'held', why: "Claude Code would not list this session's agents: agent.list is not a function" });
    host.live = new Error('timed out');
    host.ask(NEXT_ASK);
    assert.deepEqual(await hand.tick(), { kind: 'held', why: "Claude Code would not list this session's agents: timed out" });
    assert.equal(host.clears, 0);
    assert.equal(host.claims().every((call) => call.args.includes('--hold')), true);
  });

  it('runs no /clear when the hold is declined, and passes on why', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.live = 1;
    host.holdRun = { exitCode: 0, stdout: 'declined: the restart took its ask back\n' };
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'declined: the restart took its ask back' });
    host.holdRun = { exitCode: 1, stdout: 'held' };
    host.ask(NEXT_ASK);
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'held' }, 'a failed run is never a hold');
    assert.equal(host.clears, 0);
  });

  it('leaves an ask that comes during a turn without asking for the agents', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.live = 3;
    host.ask();
    hand.turnStarted();
    assert.deepEqual(await hand.tick(), { kind: 'busy' });
    assert.deepEqual([host.agentLists, host.claims()], [0, []]);
  });

  it('asks the CLI for the folder once, and after a failure again only after the retry delay', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.dirRun = { exitCode: 1, stdout: '' };
    assert.deepEqual(await hand.tick(), { kind: 'no folder' });
    host.time = DIR_RETRY_MS - 1;
    host.dirRun = new Error('node not found');
    assert.deepEqual(await hand.tick(), { kind: 'no folder' });
    assert.equal(host.calls.length, 1, 'not asked again yet');
    host.time = DIR_RETRY_MS;
    assert.deepEqual(await hand.tick(), { kind: 'no folder' }, 'the CLI failed to start');
    host.time = 2 * DIR_RETRY_MS;
    host.dirRun = { exitCode: 0, stdout: `${DIR}\n` };
    host.ask();
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
    await hand.tick();
    assert.equal(host.calls.filter((call) => call.args[1] === 'clear-dir').length, 3);
  });

  it('finds no ask for a session id unsafe in a file name', async () => {
    const host = new FakeHost();
    host.session = '../escape';
    host.ask();
    assert.deepEqual(await new ClearHand(host).tick(), { kind: 'no ask' });
  });

  it('skips a tick while the one before still runs', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    let release = (): void => undefined;
    host.clearing = new Promise((resolve) => {
      release = resolve;
    });
    host.ask();
    const first = hand.tick();
    assert.deepEqual(await hand.tick(), { kind: 'overlap' });
    release();
    assert.deepEqual(await first, { kind: 'cleared' });
  });

  it('reports a failure and acts on the ask at the next tick', async () => {
    const host = new FakeHost();
    const hand = new ClearHand(host);
    host.ask();
    host.readFailure = new Error('EBUSY');
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'EBUSY' });
    host.readFailure = 'gone';
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'gone' });
    host.readFailure = undefined;
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
  });
});

describe('liveAgentsOf', () => {
  it('counts every agent whose loop has not ended: an idle teammate and a waiting helper are live', () => {
    const statuses = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed'];
    assert.equal(liveAgentsOf(statuses.map((status) => ({ status }))), 4);
    assert.equal(liveAgentsOf([{ status: 'idle' }]), 1);
    assert.equal(liveAgentsOf([{ status: 'completed' }, { status: 'failed' }, { status: 'killed' }]), 0);
    assert.equal(liveAgentsOf([]), 0);
  });

  it('counts a status it does not know as live, so a new one never lets a /clear through', () => {
    assert.equal(liveAgentsOf([{ status: 'paused' }]), 1);
  });
});

describe('the ask files', () => {
  it('name each Claude Code session in the folder, and none for an id unsafe in a file name', () => {
    assert.equal(askFileOf(DIR, SESSION), `${DIR}/${SESSION}.ask`);
    assert.equal(outcomeFileOf(DIR, SESSION), `${DIR}/${SESSION}.outcome`);
    for (const unsafe of ['', '../x', 'a b', 'a\\b', 'x'.repeat(65)]) {
      assert.equal(isClaudeSessionId(unsafe), false, unsafe);
      assert.equal(askFileOf(DIR, unsafe), undefined, unsafe);
      assert.equal(outcomeFileOf(DIR, unsafe), undefined, unsafe);
    }
  });
});
