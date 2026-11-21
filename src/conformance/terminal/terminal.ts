import assert from 'node:assert/strict';
import { TERMINAL_REQUESTS, type PaneIdentity, type PaneOpen, type PaneState, type TerminalPort, type TerminalRequest, type Wake } from '../../plugin-api/index.ts';
import { defineContract, type Contract, type ContractCase, type Subject } from '../contract.ts';
import { nothingTerminal, yesTerminal } from './reference.ts';

type Awaitable<T> = T | Promise<T>;

/** One pane as the terminal's own program shows it, whoever opened it. */
export interface ShownPane {
  readonly pane: string;
  readonly title: string;
  readonly folder: string;
  readonly argv: readonly string[];
  /** The named window it is in; undefined when it opened in none teamrig named. */
  readonly window: string | undefined;
}

/**
 * What a terminal's port sees, as a case scripts and reads it: the terminal's program itself, faked. A case never
 * believes an answer alone; it reads here what the terminal really did.
 */
export interface TerminalWorld {
  /** Every pane there is now, in the order they opened. */
  readonly panes: () => Awaitable<readonly ShownPane[]>;
  /** The pane in front; undefined when none is. */
  readonly front: () => Awaitable<string | undefined>;
  /** Puts a pane in a state, as its session or a person at it would: a turn starts, a question shows, text is typed and not sent, the pane ends. */
  readonly put: (pane: string, state: PaneState) => Awaitable<void>;
  /** Opens a pane teamrig did not ask for, as a person does by hand, and answers its id. */
  readonly openByHand: (title: string) => Awaitable<string>;
  /** The wake texts that reached the pane's session, oldest first. */
  readonly wakes: (pane: string) => Awaitable<readonly string[]>;
  /** Each restart of the pane's command, oldest first: whether it was asked to resume. */
  readonly restarts: (pane: string) => Awaitable<readonly boolean[]>;
}

export type TerminalSubject = Subject<TerminalPort, TerminalWorld>;
export type TerminalCase = ContractCase<TerminalPort, TerminalWorld, 'terminal'>;

const IDENTITY: PaneIdentity = { session: 'worker', team: 'crew' };
const WAKE: Wake = { token: 'token-of-worker', text: 'teamrig: new work is in your inbox' };

function paneOf(over: Partial<PaneOpen> = {}): PaneOpen {
  return { title: 'worker', folder: '/work/repo', argv: ['claude', '--resume'], window: undefined, focus: 'take', identity: IDENTITY, wakeToken: WAKE.token, ...over };
}

/** Opens a pane and answers the terminal's id of it; what the terminal did for it is `open-shows-the-pane`'s to check. */
async function opened({ port }: TerminalSubject, over: Partial<PaneOpen> = {}): Promise<string> {
  const answer = await port.open(paneOf(over));
  if (answer.kind !== 'opened') {
    assert.fail(`open answered ${answer.kind}`);
  }
  return answer.pane;
}

/** One request on a pane, whichever it is, for the cases that hold every request to the same rule. */
function ask(port: TerminalPort, request: Exclude<TerminalRequest, 'open'>, pane: string): Promise<{ readonly kind: string }> {
  switch (request) {
    case 'focus':
      return port.focus(pane);
    case 'close':
      return port.close(pane);
    case 'restart':
      return port.restart(pane, false);
    case 'rename':
      return port.rename(pane, 'renamed');
    case 'deliver':
      return port.deliver(pane, WAKE);
    case 'isIdle':
      return port.isIdle(pane);
    case 'list':
      return port.list();
  }
}

const OPEN_SHOWS_THE_PANE: TerminalCase = {
  id: 'terminal.open-shows-the-pane',
  title: 'opens a pane with the title, folder and command it is given, and answers its id of it',
  features: ['pane.open'],
  run: async (subject) => {
    const pane = await opened(subject);
    assert.notEqual(pane, '');
    assert.deepEqual(await subject.world.panes(), [{ pane, title: 'worker', folder: '/work/repo', argv: ['claude', '--resume'], window: undefined }]);
  },
};

const OPEN_IN_THE_NAMED_WINDOW: TerminalCase = {
  id: 'terminal.open-in-the-named-window',
  title: 'opens each pane in the window it is given the name of, two of one name in the same window',
  features: ['pane.window'],
  run: async (subject) => {
    await opened(subject, { window: 'crew' });
    await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer', window: 'crew' });
    await opened(subject, { title: 'guest', wakeToken: 'token-of-guest', window: 'visitors' });
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.window), ['crew', 'crew', 'visitors']);
  },
};

const OPEN_IDS_DIFFER: TerminalCase = {
  id: 'terminal.open-ids-differ',
  title: 'answers a different id for each pane it opens',
  features: ['pane.open'],
  run: async (subject) => {
    const first = await opened(subject);
    const second = await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer' });
    assert.notEqual(first, second);
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.pane), [first, second]);
  },
};

const SAYS_WHAT_IT_SERVES: TerminalCase = {
  id: 'terminal.unserved-request-changes-nothing',
  title: 'lists the requests it serves, and answers unserved to any other without doing it',
  features: ['pane.open'],
  run: async (subject) => {
    const { port, world } = subject;
    const capabilities = await port.capabilities();
    assert.ok(capabilities.requests.includes('open'), 'a terminal serves open');
    assert.deepEqual(capabilities.requests.filter((request) => !TERMINAL_REQUESTS.includes(request)), []);
    assert.ok(capabilities.interfaces.length > 0, 'it names the interface versions it speaks');
    for (const version of capabilities.interfaces) {
      assert.match(version, /^\d+\.\d+$/);
    }
    const pane = await opened(subject);
    const before = await world.panes();
    for (const request of TERMINAL_REQUESTS) {
      if (request !== 'open' && !capabilities.requests.includes(request)) {
        assert.deepEqual(await ask(port, request, pane), { kind: 'unserved' }, request);
      }
    }
    assert.deepEqual(await world.panes(), before);
    assert.deepEqual(await world.wakes(pane), []);
    assert.deepEqual(await world.restarts(pane), []);
  },
};

const FOCUS_BRINGS_FORWARD: TerminalCase = {
  id: 'terminal.focus-brings-forward',
  title: 'brings the pane it is asked for to the front',
  features: ['pane.focus'],
  run: async (subject) => {
    const first = await opened(subject);
    const second = await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer' });
    assert.equal(await subject.world.front(), second);
    assert.deepEqual(await subject.port.focus(first), { kind: 'done' });
    assert.equal(await subject.world.front(), first);
  },
};

const FOCUS_OF_A_GONE_PANE: TerminalCase = {
  id: 'terminal.focus-of-a-gone-pane',
  title: 'answers gone for the focus of a pane that ended, and moves nothing',
  features: ['pane.focus'],
  run: async (subject) => {
    const first = await opened(subject);
    const second = await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer' });
    await subject.world.put(first, 'gone');
    assert.deepEqual(await subject.port.focus(first), { kind: 'gone' });
    assert.equal(await subject.world.front(), second);
  },
};

const CLOSE_ENDS_THE_PANE: TerminalCase = {
  id: 'terminal.close-ends-the-pane',
  title: 'closes the pane, and answers gone for one already closed',
  features: ['pane.close'],
  run: async (subject) => {
    const pane = await opened(subject);
    const other = await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer' });
    assert.deepEqual(await subject.port.close(pane), { kind: 'done' });
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.pane), [other]);
    assert.deepEqual(await subject.port.close(pane), { kind: 'gone' });
  },
};

const RESTART_RERUNS_THE_COMMAND: TerminalCase = {
  id: 'terminal.restart-reruns-the-command',
  title: "restarts the pane's command under the same id, resuming only when asked",
  features: ['pane.restart'],
  run: async (subject) => {
    const pane = await opened(subject);
    assert.deepEqual(await subject.port.restart(pane, false), { kind: 'done' });
    assert.deepEqual(await subject.port.restart(pane, true), { kind: 'done' });
    assert.deepEqual(await subject.world.restarts(pane), [false, true]);
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.pane), [pane]);
  },
};

const RENAME_CHANGES_THE_TITLE: TerminalCase = {
  id: 'terminal.rename-changes-the-title',
  title: "changes the pane's title, and takes the id it answered at open afterwards too",
  features: ['pane.rename'],
  run: async (subject) => {
    const pane = await opened(subject);
    assert.deepEqual(await subject.port.rename(pane, 'worker, waiting'), { kind: 'done' });
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.title), ['worker, waiting']);
    assert.deepEqual(await subject.port.rename(pane, 'worker'), { kind: 'done' });
    assert.deepEqual((await subject.world.panes()).map((shown) => shown.title), ['worker']);
  },
};

const DELIVER_REACHES_AN_IDLE_PANE: TerminalCase = {
  id: 'terminal.deliver-reaches-an-idle-pane',
  title: 'delivers a wake to an idle pane once, with the text it was given',
  features: ['pane.deliver'],
  run: async (subject) => {
    const pane = await opened(subject);
    assert.deepEqual(await subject.port.deliver(pane, WAKE), { kind: 'delivered' });
    assert.deepEqual(await subject.world.wakes(pane), [WAKE.text]);
  },
};

function heldIn(state: 'busy' | 'asking' | 'gone', id: string, title: string): TerminalCase {
  return {
    id,
    title,
    features: ['pane.deliver'],
    run: async (subject) => {
      const pane = await opened(subject);
      await subject.world.put(pane, state);
      assert.deepEqual(await subject.port.deliver(pane, WAKE), { kind: 'held', why: state });
      assert.deepEqual(await subject.world.wakes(pane), []);
    },
  };
}

const DELIVER_HELD_IN_A_BUSY_PANE = heldIn('busy', 'terminal.deliver-held-in-a-busy-pane', 'holds a wake while a turn runs in the pane, and says busy');
const DELIVER_HELD_BY_A_QUESTION = heldIn('asking', 'terminal.deliver-held-by-a-question', 'holds a wake while the pane shows a question, and says asking');
const DELIVER_HELD_FOR_A_GONE_PANE = heldIn('gone', 'terminal.deliver-held-for-a-gone-pane', 'holds a wake for a pane that ended, and says gone');

const DELIVER_ONCE_IDLE_AGAIN: TerminalCase = {
  id: 'terminal.deliver-once-idle-again',
  title: 'delivers a held wake only when it is asked again and the pane is idle',
  features: ['pane.deliver'],
  run: async (subject) => {
    const pane = await opened(subject);
    await subject.world.put(pane, 'busy');
    assert.deepEqual(await subject.port.deliver(pane, WAKE), { kind: 'held', why: 'busy' });
    await subject.world.put(pane, 'idle');
    assert.deepEqual(await subject.world.wakes(pane), []);
    assert.deepEqual(await subject.port.deliver(pane, WAKE), { kind: 'delivered' });
    assert.deepEqual(await subject.world.wakes(pane), [WAKE.text]);
  },
};

const DELIVER_REFUSED_WITH_A_WRONG_TOKEN: TerminalCase = {
  id: 'terminal.deliver-refused-with-a-wrong-token',
  title: "refuses a wake that carries another pane's token, or none, and delivers nothing",
  features: ['pane.deliver'],
  run: async (subject) => {
    const { port, world } = subject;
    const pane = await opened(subject);
    const other = await opened(subject, { title: 'reviewer', wakeToken: 'token-of-reviewer' });
    for (const token of ['token-of-reviewer', '', `${WAKE.token} `]) {
      const answer = await port.deliver(pane, { token, text: WAKE.text });
      assert.equal(answer.kind, 'refused', `the token ${JSON.stringify(token)}`);
    }
    assert.deepEqual(await world.wakes(pane), []);
    assert.deepEqual(await world.wakes(other), []);
  },
};

const IS_IDLE_TELLS_EACH_STATE: TerminalCase = {
  id: 'terminal.is-idle-tells-each-state',
  title: 'says idle for a pane it just opened, then busy, asking and gone as the pane becomes each',
  features: ['pane.is-idle'],
  run: async (subject) => {
    const pane = await opened(subject);
    assert.deepEqual(await subject.port.isIdle(pane), { kind: 'state', state: 'idle' });
    for (const state of ['busy', 'asking', 'idle', 'gone'] as const) {
      await subject.world.put(pane, state);
      assert.deepEqual(await subject.port.isIdle(pane), { kind: 'state', state });
    }
  },
};

const DRAFT_IS_NOT_IDLE: TerminalCase = {
  id: 'terminal.draft-is-not-idle',
  title: 'never calls a pane idle, nor wakes it, while its input holds unsent text',
  features: ['pane.sees-draft'],
  run: async (subject) => {
    const { port, world } = subject;
    const capabilities = await port.capabilities();
    assert.equal(capabilities.seesDraft, true, 'its capabilities say it sees a draft');
    const serves = capabilities.requests;
    assert.ok(serves.includes('deliver') || serves.includes('isIdle'), 'a terminal that sees a draft says so through deliver or isIdle');
    const pane = await opened(subject);
    await world.put(pane, 'draft');
    if (serves.includes('isIdle')) {
      assert.deepEqual(await port.isIdle(pane), { kind: 'state', state: 'draft' });
    }
    if (serves.includes('deliver')) {
      assert.deepEqual(await port.deliver(pane, WAKE), { kind: 'held', why: 'draft' });
      assert.deepEqual(await world.wakes(pane), []);
    }
  },
};

const LIST_REPORTS_EVERY_PANE: TerminalCase = {
  id: 'terminal.list-reports-every-pane',
  title: 'lists its own panes with their state and identity label, and a pane opened by hand as one that is not theirs',
  features: ['pane.list'],
  run: async (subject) => {
    const { port, world } = subject;
    const pane = await opened(subject);
    const stray = await world.openByHand('notes');
    await world.put(pane, 'busy');
    const answer = await port.list();
    if (answer.kind !== 'listed') {
      assert.fail(`list answered ${answer.kind}`);
    }
    assert.deepEqual(answer.panes.map((listed) => listed.pane).sort(), [pane, stray].sort());
    for (const listed of answer.panes) {
      if (listed.pane === pane) {
        assert.equal(listed.state, 'busy');
        assert.deepEqual(listed.identity, IDENTITY);
      } else {
        assert.notDeepEqual(listed.identity, IDENTITY, 'a pane opened by hand carries no session label of teamrig');
      }
    }
  },
};

/**
 * What every terminal must do, built in or reached through the protocol. The cases that hold a wake back are the
 * design's negative tests: a terminal passes only with them.
 */
export const TERMINAL_CONTRACT: Contract<TerminalPort, TerminalWorld, 'terminal'> = defineContract({
  port: 'terminal',
  side: 'terminal',
  cases: [
    OPEN_SHOWS_THE_PANE,
    OPEN_IDS_DIFFER,
    SAYS_WHAT_IT_SERVES,
    OPEN_IN_THE_NAMED_WINDOW,
    FOCUS_BRINGS_FORWARD,
    FOCUS_OF_A_GONE_PANE,
    CLOSE_ENDS_THE_PANE,
    RESTART_RERUNS_THE_COMMAND,
    RENAME_CHANGES_THE_TITLE,
    DELIVER_REACHES_AN_IDLE_PANE,
    DELIVER_HELD_IN_A_BUSY_PANE,
    DELIVER_HELD_BY_A_QUESTION,
    DELIVER_HELD_FOR_A_GONE_PANE,
    DELIVER_ONCE_IDLE_AGAIN,
    DELIVER_REFUSED_WITH_A_WRONG_TOKEN,
    IS_IDLE_TELLS_EACH_STATE,
    LIST_REPORTS_EVERY_PANE,
    DRAFT_IS_NOT_IDLE,
  ],
  liars: [nothingTerminal, yesTerminal],
});
