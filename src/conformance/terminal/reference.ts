import {
  TERMINAL_REQUESTS,
  type DeliverAnswer,
  type PaneAnswer,
  type PaneIdentity,
  type PaneState,
  type TerminalFailure,
  type TerminalPort,
  type TerminalRequest,
  type Unserved,
} from '../../plugin-api/index.ts';
import type { ShownPane, TerminalSubject, TerminalWorld } from './terminal.ts';

/** How a reference terminal departs from one that serves every request honestly. */
export interface ReferenceOptions {
  /** The requests it serves; left out, every one. */
  readonly serves?: readonly TerminalRequest[];
  /** Whether it sees a pane's unsent input; left out, it does. One that does not takes a pane holding a draft for an idle one. */
  readonly seesDraft?: boolean;
  /** The requests it answers as done without doing them. */
  readonly lies?: readonly TerminalRequest[];
  /** Delivers a wake whatever the pane's state or the wake's token. */
  readonly eager?: boolean;
  /** Opens every pane wherever it likes, whatever window it is given the name of. */
  readonly oneWindow?: boolean;
}

interface Pane extends ShownPane {
  readonly identity: PaneIdentity;
  readonly token: string;
  title: string;
  state: PaneState;
  readonly wakes: string[];
  readonly restarts: boolean[];
}

const UNSERVED: Unserved = { kind: 'unserved' };

/**
 * A terminal held in memory that does what the contract asks: what the kit's own spec runs the cases against, and
 * what a protocol client is tried on with no real terminal. Its options make it lie, so a spec can show which case
 * catches which lie.
 */
export function referenceTerminal(options: ReferenceOptions = {}): TerminalSubject {
  const serves = options.serves ?? TERMINAL_REQUESTS;
  const seesDraft = options.seesDraft ?? true;
  const lies = options.lies ?? [];
  const eager = options.eager ?? false;
  const oneWindow = options.oneWindow ?? false;
  const panes: Pane[] = [];
  let front: string | undefined;

  const live = (id: string): Pane | undefined => panes.find((pane) => pane.pane === id && pane.state !== 'gone');
  const seen = (pane: Pane): PaneState => (pane.state === 'draft' && !seesDraft ? 'idle' : pane.state);
  const add = (pane: Omit<Pane, 'pane' | 'state' | 'wakes' | 'restarts'>): string => {
    const id = `pane-${panes.length + 1}`;
    panes.push({ ...pane, pane: id, state: 'idle', wakes: [], restarts: [] });
    return id;
  };
  const answer = <Answer>(request: TerminalRequest, lie: Answer, act: () => Answer): Promise<Answer | Unserved> => {
    if (!serves.includes(request)) {
      return Promise.resolve(UNSERVED);
    }
    return Promise.resolve(lies.includes(request) ? lie : act());
  };
  const onPane = (request: TerminalRequest, id: string, act: (pane: Pane) => void): Promise<PaneAnswer> =>
    answer<PaneAnswer>(request, { kind: 'done' }, () => {
      const pane = live(id);
      if (pane === undefined) {
        return { kind: 'gone' };
      }
      act(pane);
      return { kind: 'done' };
    });
  const deliverTo = (id: string, token: string, text: string): DeliverAnswer => {
    const pane = live(id);
    if (pane === undefined) {
      return { kind: 'held', why: 'gone' };
    }
    if (!eager && token !== pane.token) {
      return { kind: 'refused', why: "the token is not the pane's" };
    }
    const state = seen(pane);
    if (!eager && state !== 'idle') {
      return { kind: 'held', why: state };
    }
    pane.wakes.push(text);
    return { kind: 'delivered' };
  };

  const port: TerminalPort = {
    capabilities: () => Promise.resolve({ requests: serves, interfaces: ['1.0'], seesDraft }),
    open: (request) =>
      answer('open', { kind: 'opened', pane: 'pane-1' }, () => {
        const id = add({ title: request.title, folder: request.folder, argv: request.argv, window: oneWindow ? undefined : request.window, identity: request.identity, token: request.wakeToken });
        if (request.focus === 'take' || front === undefined) {
          front = id;
        }
        return { kind: 'opened', pane: id };
      }),
    focus: (id) =>
      onPane('focus', id, () => {
        front = id;
      }),
    close: (id) =>
      onPane('close', id, (pane) => {
        pane.state = 'gone';
        front = front === id ? undefined : front;
      }),
    restart: (id, resume) =>
      onPane('restart', id, (pane) => {
        pane.restarts.push(resume);
      }),
    rename: (id, title) =>
      onPane('rename', id, (pane) => {
        pane.title = title;
      }),
    deliver: (id, wake) => answer<DeliverAnswer>('deliver', { kind: 'delivered' }, () => deliverTo(id, wake.token, wake.text)),
    isIdle: (id) =>
      answer('isIdle', { kind: 'state', state: 'idle' }, () => {
        const pane = live(id);
        return { kind: 'state', state: pane === undefined ? 'gone' : seen(pane) };
      }),
    list: () => answer('list', { kind: 'listed', panes: [] }, () => ({ kind: 'listed', panes: panes.filter((pane) => pane.state !== 'gone').map((pane) => ({ pane: pane.pane, state: seen(pane), identity: pane.identity })) })),
  };

  const world: TerminalWorld = {
    panes: () => panes.filter((pane) => pane.state !== 'gone').map(({ pane, title, folder, argv, window }) => ({ pane, title, folder, argv, window })),
    front: () => front,
    put: (id, state) => {
      const pane = panes.find((each) => each.pane === id);
      if (pane !== undefined) {
        pane.state = state;
      }
      front = state === 'gone' && front === id ? undefined : front;
    },
    openByHand: (title) => {
      const id = add({ title, folder: '', argv: [], window: undefined, identity: {}, token: `by-hand-${panes.length + 1}` });
      front = id;
      return id;
    },
    wakes: (id) => [...(panes.find((pane) => pane.pane === id)?.wakes ?? [])],
    restarts: (id) => [...(panes.find((pane) => pane.pane === id)?.restarts ?? [])],
  };

  return { port, world };
}

/** A liar that claims every request and answers each as done, having done nothing. */
export function yesTerminal(): TerminalSubject {
  return referenceTerminal({ lies: TERMINAL_REQUESTS });
}

/** A liar that claims every request and can do none. */
export function nothingTerminal(): TerminalSubject {
  const failed: TerminalFailure = { kind: 'failed', why: 'nothing here' };
  const fails = (): Promise<TerminalFailure> => Promise.resolve(failed);
  return {
    world: referenceTerminal().world,
    port: {
      capabilities: () => Promise.resolve({ requests: TERMINAL_REQUESTS, interfaces: ['1.0'], seesDraft: true }),
      open: fails,
      focus: fails,
      close: fails,
      restart: fails,
      rename: fails,
      deliver: fails,
      isIdle: fails,
      list: fails,
    },
  };
}
