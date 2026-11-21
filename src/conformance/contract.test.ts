import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OSES } from '../plugin-api/index.ts';
import { GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY, eagerGreeter, greeterContract, honestGreeter, silentGreeter, type GreeterCase } from '../testing/sample-contract.ts';
import { bind, osOf, runCases } from './contract.ts';

describe('bind', () => {
  it('closes each case over the adapter, keeping its id, title, features and operating systems', () => {
    const bound = bind({ contract: greeterContract(), make: () => honestGreeter() });
    assert.equal(bound.port, 'greeter');
    assert.equal(bound.side, 'host');
    assert.deepEqual(bound.without, {});
    assert.deepEqual(
      bound.cases.map(({ id, title, features, os }) => ({ id, title, features, os })),
      [
        { id: GREETS_KNOWN.id, title: GREETS_KNOWN.title, features: ['rules.session-start'], os: OSES },
        { id: REFUSES_UNKNOWN.id, title: REFUSES_UNKNOWN.title, features: ['rules.session-start', 'inbox.prompt-line'], os: OSES },
        { id: WINDOWS_ONLY.id, title: WINDOWS_ONLY.title, features: ['os.windows-sessions'], os: ['windows'] },
      ],
    );
  });

  it('keeps the cases an adapter leaves out, each with its reason', () => {
    const without = { [WINDOWS_ONLY.id]: 'the tool has no drive letters' };
    assert.deepEqual(bind({ contract: greeterContract(), make: () => honestGreeter(), without }).without, without);
  });

  it('makes a new subject for each case, so one case never sees what another left behind', async () => {
    let made = 0;
    const twice: GreeterCase = { ...GREETS_KNOWN, id: 'greeter.greets-known-again' };
    const bound = bind({
      contract: greeterContract({ cases: [GREETS_KNOWN, twice] }),
      make: () => {
        made += 1;
        return honestGreeter();
      },
    });
    assert.deepEqual(
      (await runCases(bound.cases)).map((result) => result.outcome.kind),
      ['passed', 'passed'],
    );
    assert.equal(made, 2);
  });

  it('waits for a subject that is made later, and for a case that ends later', async () => {
    const late: GreeterCase = {
      ...GREETS_KNOWN,
      run: async ({ port }) => {
        await Promise.resolve();
        assert.equal(port.greet('ada'), 'hello nobody');
      },
    };
    const bound = bind({ contract: greeterContract({ cases: [late] }), make: () => Promise.resolve(honestGreeter()) });
    const [result] = await runCases(bound.cases);
    assert.equal(result?.outcome.kind, 'failed');
  });
});

describe('runCases', () => {
  it('passes every case of an adapter that does what the contract asks', async () => {
    const results = await runCases(bind({ contract: greeterContract(), make: () => honestGreeter() }).cases);
    assert.deepEqual(
      results.map(({ id, features, outcome }) => ({ id, features, outcome })),
      [
        { id: GREETS_KNOWN.id, features: ['rules.session-start'], outcome: { kind: 'passed' } },
        { id: REFUSES_UNKNOWN.id, features: ['rules.session-start', 'inbox.prompt-line'], outcome: { kind: 'passed' } },
        { id: WINDOWS_ONLY.id, features: ['os.windows-sessions'], outcome: { kind: 'passed' } },
      ],
    );
  });

  it('says why a case failed and still runs the ones after it', async () => {
    const results = await runCases(bind({ contract: greeterContract(), make: silentGreeter }).cases);
    assert.deepEqual(
      results.map((result) => result.outcome.kind),
      ['failed', 'failed', 'failed'],
    );
    const [first] = results;
    assert.ok(first?.outcome.kind === 'failed' && first.outcome.reason.includes('hello ada'), JSON.stringify(first));
  });

  it('fails only the cases a liar cannot meet', async () => {
    const results = await runCases(bind({ contract: greeterContract(), make: eagerGreeter }).cases);
    assert.deepEqual(
      results.map((result) => result.outcome.kind),
      ['passed', 'failed', 'passed'],
    );
  });

  it('reads a thrown value that is no error as its text', async () => {
    const thrower: GreeterCase = {
      ...GREETS_KNOWN,
      run: () => {
        throw 'not an error';
      },
    };
    const [result] = await runCases(bind({ contract: greeterContract({ cases: [thrower] }), make: () => honestGreeter() }).cases);
    assert.deepEqual(result?.outcome, { kind: 'failed', reason: 'not an error' });
  });
});

describe('osOf', () => {
  it('names the operating system of each platform a proof is made on, and no other', () => {
    assert.equal(osOf('win32'), 'windows');
    assert.equal(osOf('linux'), 'linux');
    assert.equal(osOf('darwin'), 'macos');
    assert.equal(osOf('freebsd'), undefined);
  });
});
