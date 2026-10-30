import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { coveringClaims, freezeText, parseClaims, quietClaimText, readClaims, type Claim } from './freezes.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function claim(overrides: Partial<Claim> = {}): Claim {
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

describe('parseClaims', () => {
  it('reads no freezes from a missing file and every freeze from a written one', () => {
    assert.deepEqual(parseClaims(undefined), { kind: 'read', claims: [] });
    assert.deepEqual(parseClaims(JSON.stringify([claim()])), { kind: 'read', claims: [claim()] });
  });

  it('skips an entry missing a field or with targets that are not names', () => {
    const { session: _session, ...noSession } = claim();
    const text = JSON.stringify([noSession, { ...claim(), targets: 'cloud-api' }, 7, claim({ session: 'jobs' })]);
    assert.deepEqual(parseClaims(text), { kind: 'read', claims: [claim({ session: 'jobs' })] });
  });

  it('calls a file caught mid-write or holding no array unreadable, never empty', () => {
    assert.deepEqual(parseClaims('[{"session": "po"'), { kind: 'unreadable', reason: 'not JSON' });
    assert.deepEqual(parseClaims('{}'), { kind: 'unreadable', reason: 'not a JSON array' });
  });

  it('reads the freezes file through the file port', async () => {
    const files = new MemoryFiles({ '/team/data/deploys/claims.json': JSON.stringify([claim()]) });
    assert.deepEqual(await readClaims(files, '/team/data/deploys/claims.json'), { kind: 'read', claims: [claim()] });
  });
});

describe('coveringClaims', () => {
  it('keeps the freezes still holding that name one of the targets', () => {
    const ended = claim({ until: '2030-01-08T10:00:00.000Z' });
    const elsewhere = claim({ targets: ['pipeline'] });
    const shared = claim({ session: 'jobs', targets: ['pipeline', 'cloud-api'] });
    assert.deepEqual(coveringClaims([claim(), ended, elsewhere, shared], ['cloud-api'], NOW), [claim(), shared]);
    assert.deepEqual(coveringClaims([claim()], [], NOW), []);
  });
});

describe('freezeText', () => {
  it('names the session, targets, end and metric of a deploy freeze', () => {
    assert.equal(freezeText(claim({ targets: ['cloud-api', 'cloud-web'] }), TimeZone.UTC), 'deploy freeze by po on cloud-api,cloud-web until 2030-01-08 11:00 UTC (p95 latency)');
  });

  it('shows an end it cannot read as written', () => {
    assert.equal(freezeText(claim({ until: 'soon' }), TimeZone.UTC), 'deploy freeze by po on cloud-api until soon (p95 latency)');
  });

  it("names the end on the team's clock", () => {
    assert.equal(freezeText(claim(), JERUSALEM), 'deploy freeze by po on cloud-api until 2030-01-08 13:00 IST (p95 latency)');
  });
});

describe('quietClaimText', () => {
  it('keeps the old name for the deploy-status line outside tools read', () => {
    assert.equal(quietClaimText(claim(), JERUSALEM), 'quiet claim by po on cloud-api until 2030-01-08 13:00 IST (p95 latency)');
  });
});
