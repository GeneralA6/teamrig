import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_REQUESTS, featuresOf, type TerminalRequest } from '../../plugin-api/index.ts';
import { bind, runCases } from '../contract.ts';
import { entryOf, kitProblems } from '../kit.ts';
import { nothingTerminal, referenceTerminal, yesTerminal, type ReferenceOptions } from './reference.ts';
import { TERMINAL_CONTRACT } from './terminal.ts';

/** The ids of the cases a terminal built with `options` fails, in the contract's order. */
async function failedBy(options: ReferenceOptions = {}): Promise<readonly string[]> {
  const results = await runCases(bind({ contract: TERMINAL_CONTRACT, make: () => referenceTerminal(options) }).cases);
  return results.filter((result) => result.outcome.kind === 'failed').map((result) => result.id.slice('terminal.'.length));
}

const DELIVER_CASES = ['deliver-reaches-an-idle-pane', 'deliver-held-in-a-busy-pane', 'deliver-held-by-a-question', 'deliver-held-for-a-gone-pane', 'deliver-once-idle-again', 'deliver-refused-with-a-wrong-token'];

/** The cases that catch a terminal answering one request as done without doing it. */
const CAUGHT: Readonly<Record<Exclude<TerminalRequest, 'open'>, readonly string[]>> = {
  focus: ['focus-brings-forward', 'focus-of-a-gone-pane'],
  close: ['close-ends-the-pane'],
  restart: ['restart-reruns-the-command'],
  rename: ['rename-changes-the-title'],
  deliver: [...DELIVER_CASES, 'draft-is-not-idle'],
  isIdle: ['is-idle-tells-each-state', 'draft-is-not-idle'],
  list: ['list-reports-every-pane'],
};

describe('the terminal contract', () => {
  it('passes a terminal that serves every request honestly', async () => {
    assert.deepEqual(await failedBy(), []);
  });

  it('holds both its liars on every feature, with well-named cases', async () => {
    assert.deepEqual(await kitProblems([entryOf(TERMINAL_CONTRACT)]), []);
    assert.equal(TERMINAL_CONTRACT.liars.includes(yesTerminal) && TERMINAL_CONTRACT.liars.includes(nothingTerminal), true);
  });

  it('has a case for every terminal row of the registry', () => {
    assert.deepEqual(entryOf(TERMINAL_CONTRACT).features, featuresOf('terminal').map((row) => row.id));
  });

  for (const request of TERMINAL_REQUESTS) {
    if (request === 'open') continue;
    it(`catches a terminal that answers ${request} as done without doing it, by the cases of that request alone`, async () => {
      assert.deepEqual(await failedBy({ lies: [request] }), CAUGHT[request]);
    });
  }

  it('catches a terminal whose open answers an id and opens nothing', async () => {
    const failed = await failedBy({ lies: ['open'] });
    assert.ok(failed.includes('open-shows-the-pane') && failed.includes('open-ids-differ'), failed.join(', '));
  });

  it('catches a terminal that opens every pane where it likes, by the window case alone', async () => {
    assert.deepEqual(await failedBy({ oneWindow: true }), ['open-in-the-named-window']);
  });

  it('catches a terminal that delivers whatever the pane does and whatever token the wake carries', async () => {
    assert.deepEqual(await failedBy({ eager: true }), ['deliver-held-in-a-busy-pane', 'deliver-held-by-a-question', 'deliver-once-idle-again', 'deliver-refused-with-a-wrong-token', 'draft-is-not-idle']);
  });

  it('fails a terminal that says it sees a draft and does not, and only on the draft case', async () => {
    const blind = (): ReturnType<typeof referenceTerminal> => {
      const { port, world } = referenceTerminal({ seesDraft: false });
      return { world, port: { ...port, capabilities: async () => ({ ...(await port.capabilities()), seesDraft: true }) } };
    };
    const results = await runCases(bind({ contract: TERMINAL_CONTRACT, make: blind }).cases);
    assert.deepEqual(results.filter((result) => result.outcome.kind === 'failed').map((result) => result.id), ['terminal.draft-is-not-idle']);
  });

  it('asks a terminal that serves only open for unserved answers, and passes it on the open cases', async () => {
    const failed = await failedBy({ serves: ['open'], seesDraft: false });
    assert.deepEqual(failed.filter((id) => id.startsWith('open-') || id === 'unserved-request-changes-nothing'), []);
    assert.ok(failed.includes('focus-brings-forward') && failed.includes('list-reports-every-pane'), failed.join(', '));
  });

  it('fails a terminal that does an unserved request anyway', async () => {
    const sly = (): ReturnType<typeof referenceTerminal> => {
      const { port, world } = referenceTerminal();
      return { world, port: { ...port, capabilities: async () => ({ ...(await port.capabilities()), requests: ['open'] }) } };
    };
    const results = await runCases(bind({ contract: TERMINAL_CONTRACT, make: sly }).cases);
    // The draft case fails too: it says it sees a draft, and lists neither request that could say so.
    assert.deepEqual(results.filter((result) => result.outcome.kind === 'failed').map((result) => result.id), ['terminal.unserved-request-changes-nothing', 'terminal.draft-is-not-idle']);
  });
});
