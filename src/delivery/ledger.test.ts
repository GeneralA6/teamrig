import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { appendDeploy, appendRecord, ledgerLine, LEDGER_MD_HEADER, parseLedger, parseLedgerMd, type DeployRecord, type JobRecord, rangeText } from './ledger.ts';

const PLACES = { ledger: '/team/data/deploys/ledger.jsonl', ledgerMd: '/team/data/deploys/ledger.md' };

function deploy(overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    type: 'deploy',
    kind: 'deploy',
    session: 'api',
    repo: 'api',
    range: '1a2b3c4d..5e6f7a8b',
    what: 'Cloud api (deploys on push; not observed here)',
    note: 'pushed',
    startedAt: '2030-01-08T10:00:00.000Z',
    rolledAt: '2030-01-08T10:04:30.000Z',
    ...overrides,
  };
}

describe('ledgerLine', () => {
  it('writes the deploy as one ledger.md line, by the minute it deployed', () => {
    assert.equal(ledgerLine(deploy()), '- 2030-01-08 10:04 | api | api | 1a2b3c4d..5e6f7a8b | Cloud api (deploys on push; not observed here) | deploy | pushed');
  });

  it('keeps every field to its column: a bar or line break becomes a slash', () => {
    assert.equal(ledgerLine(deploy({ what: 'a | b', note: 'line one\r\nline two' })), '- 2030-01-08 10:04 | api | api | 1a2b3c4d..5e6f7a8b | a / b | deploy | line one//line two');
  });
});

describe('appendDeploy', () => {
  it('appends the record to the JSON ledger and its line to ledger.md, starting a missing ledger.md with its header', async () => {
    const files = new MemoryFiles();
    await appendDeploy(files, PLACES, deploy());
    await appendDeploy(files, PLACES, deploy({ note: 'second' }));
    assert.equal(files.get(PLACES.ledger), `${JSON.stringify(deploy())}\n${JSON.stringify(deploy({ note: 'second' }))}\n`);
    assert.equal(files.get(PLACES.ledgerMd), `${LEDGER_MD_HEADER}\n${ledgerLine(deploy())}\n${ledgerLine(deploy({ note: 'second' }))}\n`);
  });

  it('keeps the header an existing ledger.md has', async () => {
    const files = new MemoryFiles({ [PLACES.ledgerMd]: '# Deploy ledger\n' });
    await appendDeploy(files, PLACES, deploy());
    assert.equal(files.get(PLACES.ledgerMd), `# Deploy ledger\n${ledgerLine(deploy())}\n`);
  });
});

describe('rangeText', () => {
  it('names one commit, a range by its ends, and no commits by the fallback', () => {
    assert.equal(rangeText(['1234567890ab'], 'f'), '12345678');
    assert.equal(rangeText(['1111111111', '2222222222', '3333333333'], 'f'), '11111111..33333333');
    assert.equal(rangeText([], 'abcdef0123456'), 'abcdef01');
  });
});

describe('parseLedger', () => {
  const job: JobRecord = { type: 'load', id: 'b425c3c9', session: 'ops', what: 'db trim', targets: 'host', startedAt: '2030-01-08T09:00:00.000Z', endedAt: null };
  const queuedStep = { type: 'heavy', id: 'h1', session: 'dev', what: 'tests', startedAt: '2030-01-08T09:10:00.000Z', endedAt: '2030-01-08T09:12:00.000Z', exitCode: 0 };

  it('reads what appendRecord writes, each type in file order', async () => {
    const files = new MemoryFiles();
    for (const record of [job, deploy(), { ...job, targets: ['api'], endedAt: '2030-01-08T11:00:00.000Z' }]) {
      await appendRecord(files, PLACES.ledger, record);
    }
    await files.append(PLACES.ledger, `${JSON.stringify(queuedStep)}\n`);
    assert.deepEqual(parseLedger((await files.read(PLACES.ledger)) ?? ''), [job, deploy(), { ...job, targets: ['api'], endedAt: '2030-01-08T11:00:00.000Z' }, queuedStep]);
  });

  it('leaves out damaged lines, other types and records with a bad field', () => {
    const bad = [
      '{"type":"heavy"',
      JSON.stringify({ type: 'claim', id: 'c1' }),
      JSON.stringify({ ...queuedStep, startedAt: 'yesterday' }),
      JSON.stringify({ ...queuedStep, exitCode: 'ok' }),
      JSON.stringify({ ...job, targets: 'api' }),
      JSON.stringify({ ...job, endedAt: 5 }),
      JSON.stringify({ ...deploy(), kind: 'revert' }),
      JSON.stringify({ ...deploy(), note: undefined }),
    ];
    assert.deepEqual(parseLedger([...bad, JSON.stringify(queuedStep)].join('\r\n')), [queuedStep]);
  });

  it("reads a queued step's kit, wait, sharing and memory, and leaves out only a bad optional field", () => {
    const measured = { ...queuedStep, kit: '0.113.0', queuedAt: '2030-01-08T09:01:00.000Z', shared: true, peakTreeMb: 1800, lowFreeMb: 6200 };
    const damaged = { ...queuedStep, kit: 113, queuedAt: 'soon', shared: 'yes', peakTreeMb: -1, lowFreeMb: 1.5 };
    assert.deepEqual(parseLedger([JSON.stringify(measured), JSON.stringify(damaged)].join('\n')), [measured, queuedStep]);
  });

  it("reads the targets a deploy of some of its repository's targets names, and leaves out only bad ones", () => {
    const some = deploy({ targets: ['api', 'live'] });
    const damaged = { ...deploy(), targets: 'api' };
    assert.deepEqual(parseLedger([JSON.stringify(some), JSON.stringify(damaged)].join('\n')), [some, deploy()]);
  });
});

describe('parseLedgerMd', () => {
  it('reads the deploys and rollbacks, what ledgerLine writes included, and leaves out the rest', () => {
    const text = [
      LEDGER_MD_HEADER,
      '- 2030-01-08 14:05 | lead | - | - | - | start | ledger started',
      ledgerLine(deploy()),
      '- 2030-01-08 12:00 | ops | pipeline | a..b | fleet | rollback | bad image',
      '- 2030-01-08 12:00 | ops | pipeline | a..b | fleet',
      '- 2030-01-08 25:00 | ops | pipeline | a..b | fleet | deploy | x',
      '- 08/01/2030 12:00 | ops | pipeline | a..b | fleet | deploy | x',
      '  - 2030-01-08 12:00 | ops | pipeline | a..b | fleet | deploy | indented',
    ].join('\n');
    assert.deepEqual(parseLedgerMd(text), [
      { rolledAt: Date.parse('2030-01-08T10:04:00Z'), session: 'api', repo: 'api', kind: 'deploy' },
      { rolledAt: Date.parse('2030-01-08T12:00:00Z'), session: 'ops', repo: 'pipeline', kind: 'rollback' },
    ]);
  });
});
