import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { appendDeploy, ledgerLine, LEDGER_MD_HEADER, type DeployRecord, rangeText } from './ledger.ts';

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
  it('writes the deploy as one ledger.md line, by its rolled-at minute', () => {
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
