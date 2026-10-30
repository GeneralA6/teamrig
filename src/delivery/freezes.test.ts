import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { coveringFreezes, freezeText, parseFreezes, quietClaimText, readFreezes, type Freeze } from './freezes.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function freeze(overrides: Partial<Freeze> = {}): Freeze {
  return {
    session: 'po',
    targets: ['cloud-api'],
    metric: 'p95 latency',
    why: 'baseline before the cache change',
    from: '2030-01-08T09:00:00.000Z',
    until: '2030-01-08T11:00:00.000Z',
    ...overrides,
  };
}

describe('parseFreezes', () => {
  it('reads no freezes from a missing file and every freeze from a written one', () => {
    assert.deepEqual(parseFreezes(undefined), { kind: 'read', freezes: [] });
    assert.deepEqual(parseFreezes(JSON.stringify([freeze()])), { kind: 'read', freezes: [freeze()] });
  });

  it('skips an entry missing a field or with targets that are not names', () => {
    const { session: _session, ...noSession } = freeze();
    const text = JSON.stringify([noSession, { ...freeze(), targets: 'cloud-api' }, 7, freeze({ session: 'jobs' })]);
    assert.deepEqual(parseFreezes(text), { kind: 'read', freezes: [freeze({ session: 'jobs' })] });
  });

  it('calls a file caught mid-write or holding no array unreadable, never empty', () => {
    assert.deepEqual(parseFreezes('[{"session": "po"'), { kind: 'unreadable', reason: 'not JSON' });
    assert.deepEqual(parseFreezes('{}'), { kind: 'unreadable', reason: 'not a JSON array' });
  });

  it('reads the freezes file through the file port', async () => {
    const files = new MemoryFiles({ '/team/data/deploys/claims.json': JSON.stringify([freeze()]) });
    assert.deepEqual(await readFreezes(files, '/team/data/deploys/claims.json'), { kind: 'read', freezes: [freeze()] });
  });
});

describe('coveringFreezes', () => {
  it('keeps the freezes still holding that name one of the targets', () => {
    const ended = freeze({ until: '2030-01-08T10:00:00.000Z' });
    const elsewhere = freeze({ targets: ['pipeline'] });
    const shared = freeze({ session: 'jobs', targets: ['pipeline', 'cloud-api'] });
    assert.deepEqual(coveringFreezes([freeze(), ended, elsewhere, shared], ['cloud-api'], NOW), [freeze(), shared]);
    assert.deepEqual(coveringFreezes([freeze()], [], NOW), []);
  });
});

describe('freezeText', () => {
  it('names the session, targets, end and metric of a deploy freeze', () => {
    assert.equal(freezeText(freeze({ targets: ['cloud-api', 'cloud-web'] }), TimeZone.UTC), 'deploy freeze by po on cloud-api,cloud-web until 2030-01-08 11:00 UTC (p95 latency)');
  });

  it('shows an end it cannot read as written', () => {
    assert.equal(freezeText(freeze({ until: 'soon' }), TimeZone.UTC), 'deploy freeze by po on cloud-api until soon (p95 latency)');
  });

  it("names the end on the team's clock", () => {
    assert.equal(freezeText(freeze(), JERUSALEM), 'deploy freeze by po on cloud-api until 2030-01-08 13:00 IST (p95 latency)');
  });
});

describe('quietClaimText', () => {
  it('keeps the old name for the deploy-status line outside tools read', () => {
    assert.equal(quietClaimText(freeze(), JERUSALEM), 'quiet claim by po on cloud-api until 2030-01-08 13:00 IST (p95 latency)');
  });
});
