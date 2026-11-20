import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY, eagerGreeter, greeterContract, silentGreeter, type GreeterCase } from '../testing/sample-contract.ts';
import { entryOf, kitProblems } from './kit.ts';

describe('entryOf', () => {
  it('lists a contract by its port, side, cases and the features they name, each once', () => {
    const entry = entryOf(greeterContract());
    assert.equal(entry.port, 'greeter');
    assert.equal(entry.side, 'host');
    assert.deepEqual(entry.features, ['rules.session-start', 'inbox.prompt-line', 'os.windows-sessions']);
    assert.deepEqual(entry.cases, [
      { id: GREETS_KNOWN.id, features: ['rules.session-start'] },
      { id: REFUSES_UNKNOWN.id, features: ['rules.session-start', 'inbox.prompt-line'] },
      { id: WINDOWS_ONLY.id, features: ['os.windows-sessions'] },
    ]);
  });

  it('runs every case against each liar, on a new subject each time', async () => {
    const runs = await entryOf(greeterContract()).againstLiars();
    assert.deepEqual(
      runs.map((results) => results.map((result) => result.outcome.kind)),
      [
        ['failed', 'failed', 'failed'],
        ['passed', 'failed', 'passed'],
      ],
    );
  });
});

describe('kitProblems', () => {
  it('finds nothing in a contract whose every feature fails a case for each liar', async () => {
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ liars: [silentGreeter] }))]), []);
    assert.deepEqual(await kitProblems([]), []);
  });

  it('names the feature a liar passes every case of, and the liar', async () => {
    assert.deepEqual(await kitProblems([entryOf(greeterContract())]), ['greeter: liar 2 passes every case of os.windows-sessions']);
  });

  it('is content once a negative case tells that liar from a real adapter', async () => {
    const noStrangers: GreeterCase = { ...REFUSES_UNKNOWN, id: 'greeter.windows-refuses-unknown', features: ['os.windows-sessions'] };
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ cases: [GREETS_KNOWN, REFUSES_UNKNOWN, WINDOWS_ONLY, noStrangers] }))]), []);
  });

  it('refuses a contract with no liar, and one with no case', async () => {
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ liars: [] }))]), ['greeter has no liar']);
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ cases: [], liars: [silentGreeter] }))]), ['greeter has no case']);
  });

  it('holds a case id to its port and to lower-case words, once in the contract', async () => {
    const cases: readonly GreeterCase[] = [GREETS_KNOWN, { ...GREETS_KNOWN, id: 'other.greets-known' }, { ...GREETS_KNOWN, id: 'greeter.Greets_Known' }, { ...GREETS_KNOWN, id: 'greeter.' }, GREETS_KNOWN];
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ cases, liars: [silentGreeter] }))]), [
      'other.greets-known: a case of greeter is named greeter.<lower-case words joined by ->',
      'greeter.Greets_Known: a case of greeter is named greeter.<lower-case words joined by ->',
      'greeter.: a case of greeter is named greeter.<lower-case words joined by ->',
      `${GREETS_KNOWN.id} names two cases`,
    ]);
  });

  it('refuses a case that names no feature, a port that is no lower-case words, and a port named twice', async () => {
    const bare: GreeterCase = { ...GREETS_KNOWN, id: 'greeter.bare', features: [] };
    assert.deepEqual(await kitProblems([entryOf(greeterContract({ cases: [GREETS_KNOWN, bare], liars: [silentGreeter] }))]), ['greeter.bare names no feature']);
    const shouted = greeterContract({ port: 'Greeter', cases: [{ ...GREETS_KNOWN, id: 'Greeter.greets-known' }], liars: [silentGreeter] });
    assert.deepEqual(await kitProblems([entryOf(shouted)]), ['Greeter: a port is lower-case words joined by -']);
    const one = entryOf(greeterContract({ liars: [silentGreeter] }));
    assert.deepEqual(await kitProblems([one, one]), ['greeter names two contracts']);
  });
});
