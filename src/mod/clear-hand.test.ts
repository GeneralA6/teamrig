import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFRESH } from '../config/defaults.ts';
import { personHoldOf } from '../refresh/restart.ts';
import {
  askFileOf,
  bandLine,
  ClearHand,
  DEFAULT_PERSON_HOLD,
  DIR_RETRY_MS,
  HOLD_BUTTON_MS,
  isClaudeSessionId,
  liveAgentsOf,
  outcomeFileOf,
  parseHandAsk,
  REFRESHING_SHOWN_MS,
  sameBand,
  type BandView,
  type ClearHandHost,
  type CliRun,
  type PersonHold,
} from './clear-hand.ts';

const DIR = '/kit/clear-asks';
const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const AT = '2030-01-08T09:59:59.000Z';
/** No hold for the person: the hand claims each ask it is free to. */
const NO_HOLD: PersonHold = { countdownMs: 0, afterActivityMs: 0 };
/** The config's defaults: a 20 s count, and 5 min after the person's last key. */
const HOLD: PersonHold = { countdownMs: 20_000, afterActivityMs: 300_000 };

/** The runner's ask as it posts it: `n` makes each one new, `at` names the restart request. */
function askOf(n: number, hold: PersonHold = NO_HOLD, at: string = AT): string {
  return `${JSON.stringify({ team: 'app', id: 'alpha', at, askedAt: new Date(Date.parse(AT) + n * 15_000).toISOString(), hold })}\n`;
}

const ASK = askOf(1);
const NEXT_ASK = askOf(2);

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
  /** The prompt box's text, or why Claude Code would not read it. */
  prompt: string | Error = '';
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

  async draft(): Promise<string> {
    if (this.prompt instanceof Error) {
      throw this.prompt;
    }
    return this.prompt;
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
    assert.deepEqual(host.claims(), [{ args: ['hook', 'clear-claim', '--hold', '--why', '2 agents of this session still live'], stdin: JSON.stringify({ session_id: SESSION }) }]);
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
        ['hook', 'clear-claim', '--hold', '--why', '2 agents of this session still live'],
        ['hook', 'clear-claim', '--hold', '--why', '1 agent of this session still live'],
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
    assert.deepEqual(
      host.claims().map((call) => call.args.slice(2)),
      [
        ['--hold', '--why', "Claude Code would not list this session's agents: agent.list is not a function"],
        ['--hold', '--why', "Claude Code would not list this session's agents: timed out"],
      ],
      'each hold names its reason, which the restart names if it gives up',
    );
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

/** A hand whose runner holds the person's /clear the config's default way, with the clock at 0. */
function personHand(): { readonly host: FakeHost; readonly hand: ClearHand } {
  const host = new FakeHost();
  return { host, hand: new ClearHand(host) };
}

describe('ClearHand: the person at the tab', () => {
  it('counts down on the band, holding each ask until the count ends, then claims the next', async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
    assert.deepEqual(hand.band(), { kind: 'counting', secondsLeft: 20 });
    host.time = 4_500;
    assert.deepEqual(hand.band(), { kind: 'counting', secondsLeft: 16 }, 'whole seconds, rounded up');
    host.time = 15_000;
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 5 s left' }, 'the same count: one request');
    host.time = 30_000;
    assert.deepEqual(hand.band(), { kind: 'refreshing' }, 'the count ended: the /clear comes with the next ask');
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
    assert.equal(hand.band(), undefined);
    assert.deepEqual(
      host.claims().map((call) => call.args.slice(2)),
      [['--hold', '--why', 'the band counts down: 20 s left'], ['--hold', '--why', 'the band counts down: 5 s left'], []],
      'each ask answered at once: the runner ends a tab that leaves one',
    );
  });

  it("counts the config's defaults down on an ask that carries no hold (an older runner's)", async () => {
    const { host, hand } = personHand();
    host.ask('{"team":"app","id":"alpha","at":"2030-01-08T09:59:59.000Z","askedAt":"2030-01-08T10:00:15.000Z"}\n');
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
  });

  it('starts a new count for a new restart request, and after a turn', async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    host.time = 15_000;
    host.ask(askOf(2, HOLD, '2030-01-08T10:00:14.000Z'));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
    hand.turnStarted();
    assert.equal(hand.band(), undefined, 'a turn hides the band');
    hand.turnEnded();
    host.time = 60_000;
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
  });

  it('holds while the prompt box holds a draft, or Claude Code will not read it, and hides the band', async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    host.prompt = '  half a thought ';
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the prompt box holds an unsent draft' });
    assert.equal(hand.band(), undefined);
    host.prompt = new Error('no prompt box');
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'Claude Code would not read the prompt box: no prompt box' });
    host.prompt = ' \n';
    host.ask(askOf(4, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' }, 'blank is no draft: a new count');
    assert.equal(host.clears, 0);
  });

  it("holds afterActivityMs after the person's last key or prompt, hiding the band, then counts from the next ask", async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    host.time = 5_000;
    hand.personActed();
    assert.equal(hand.band(), undefined, 'typing hides the band');
    host.time = 65_000;
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the person was active in this tab 60 s ago' });
    host.time = 305_000;
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
  });

  it('holds HOLD_BUTTON_MS after the band\'s Hold, then counts again', async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    hand.holdRefresh();
    assert.equal(hand.band(), undefined);
    host.time = 60_000;
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the person pressed Hold: 9 min left' });
    host.time = HOLD_BUTTON_MS;
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' });
  });

  it("claims the next ask after Refresh now, through the person's Hold, activity and count", async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    hand.holdRefresh();
    hand.personActed();
    hand.refreshNow();
    assert.deepEqual(hand.band(), { kind: 'refreshing' });
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'cleared' });
    assert.equal(hand.band(), undefined);
  });

  it('lets a draft or a live helper hold the ask after Refresh now, which it then forgets', async () => {
    const { host, hand } = personHand();
    hand.refreshNow();
    host.prompt = 'wait';
    host.ask(askOf(1, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the prompt box holds an unsent draft' });
    assert.equal(hand.band(), undefined);
    host.prompt = '';
    hand.refreshNow();
    host.live = 1;
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: '1 agent of this session still live' });
    host.live = 0;
    host.ask(askOf(3, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'held', why: 'the band counts down: 20 s left' }, 'a count, not the forgotten Refresh now');
  });

  it('ends the count when the restart is no longer pending, and reads "refreshing" only REFRESHING_SHOWN_MS', async () => {
    const { host, hand } = personHand();
    host.ask(askOf(1, HOLD));
    await hand.tick();
    host.holdRun = { exitCode: 0, stdout: 'declined: the restart is no longer pending\n' };
    host.ask(askOf(2, HOLD));
    assert.deepEqual(await hand.tick(), { kind: 'declined', why: 'declined: the restart is no longer pending' });
    assert.equal(hand.band(), undefined);

    host.holdRun = { exitCode: 0, stdout: 'held\n' };
    host.ask(askOf(3, HOLD, '2030-01-08T10:00:30.000Z'));
    await hand.tick();
    host.time = 20_000 + REFRESHING_SHOWN_MS - 1;
    assert.deepEqual(hand.band(), { kind: 'refreshing' });
    host.time += 1;
    assert.equal(hand.band(), undefined, 'no ask came: the band does not stay');
    hand.refreshNow();
    host.time += REFRESHING_SHOWN_MS;
    assert.equal(hand.band(), undefined);
  });
});

describe('the band', () => {
  const twenty: BandView = { kind: 'counting', secondsLeft: 20 };
  const refreshing: BandView = { kind: 'refreshing' };

  it('reads the count, or that the /clear comes next', () => {
    assert.equal(bandLine(twenty), 'teamrig: this session refreshes in 20 s, a fresh start from its handover');
    assert.equal(bandLine(refreshing), 'teamrig: this session is refreshing, a fresh start from its handover');
  });

  it('is the same band only for the same count, both refreshing or both none', () => {
    assert.ok(sameBand(undefined, undefined));
    assert.ok(sameBand(twenty, { kind: 'counting', secondsLeft: 20 }));
    assert.ok(sameBand(refreshing, { kind: 'refreshing' }));
    for (const [a, b] of [[twenty, { kind: 'counting', secondsLeft: 19 }], [twenty, refreshing], [refreshing, twenty], [twenty, undefined], [undefined, refreshing]] as const) {
      assert.ok(!sameBand(a, b), JSON.stringify([a, b]));
    }
  });
});

describe('parseHandAsk', () => {
  it("reads the ask's request and the hold it carries", () => {
    assert.deepEqual(parseHandAsk(askOf(1, HOLD)), { request: AT, hold: HOLD });
    assert.deepEqual(parseHandAsk(askOf(1, NO_HOLD)), { request: AT, hold: NO_HOLD });
  });

  it("holds the config's defaults when the ask carries no hold or a damaged one", () => {
    assert.deepEqual(DEFAULT_PERSON_HOLD, personHoldOf(DEFAULT_REFRESH), "the mod's fallback is the config's default");
    for (const hold of [undefined, null, [], { countdownMs: 20_000 }, { countdownMs: -1, afterActivityMs: 0 }, { countdownMs: '20s', afterActivityMs: 0 }]) {
      assert.deepEqual(parseHandAsk(JSON.stringify({ at: AT, hold })).hold, DEFAULT_PERSON_HOLD, JSON.stringify(hold));
    }
    for (const text of ['not json', '[]', '{"at":3}']) {
      assert.deepEqual(parseHandAsk(text), { request: undefined, hold: DEFAULT_PERSON_HOLD }, text);
    }
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
