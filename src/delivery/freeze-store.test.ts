import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { addClaim, CLAIMS_LOCK_TTL_MS, claimRefusal, releaseClaim, renderClaimsMd, type ClaimPorts, type ClaimRequest, type ClaimRules } from './freeze-store.ts';
import { withdrawnLock } from '../testing/withdrawn-lock.ts';
import { HostLock, type HostLockInfo } from './host-lock.ts';

const PLACES = { claims: '/team/deploys/claims.json', claimsMd: '/team/deploys/claims.md' };
const LOCK = '/team/deploys/claims.lock';
const RULES: ClaimRules = { maxMinutes: 120, knownTargets: ['api', 'discovery', 'cloud-api'], scanner: new SecretScanner() };
const REQUEST: ClaimRequest = { session: 'po', targets: ['api', 'discovery'], metric: 'p95 latency', why: 'measuring the  new\ncache', minutes: 45 };

/** A freeze another session made that ends at 10:30, and one that ended at 09:00. */
const HELD = [
  { session: 'web', targets: ['cloud-api'], metric: 'LCP', why: 'image change', from: '2030-01-08T09:30:00.000Z', until: '2030-01-08T10:30:00.000Z' },
  { session: 'ops', targets: ['api'], metric: 'cpu', why: 'old', from: '2030-01-08T08:00:00.000Z', until: '2030-01-08T09:00:00.000Z' },
];

interface World {
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly ports: ClaimPorts;
}

function world(initial: Readonly<Record<string, string>> = {}): World {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const lock = new HostLock(LOCK, CLAIMS_LOCK_TTL_MS, { files, clock, sleep: clock.sleep, pid: 7, alive: (pid) => pid === 7 || pid === 9, newId: () => 'claims-1' });
  return { files, clock, ports: { files, clock, zone: TimeZone.UTC, lock } };
}

function claimsIn(files: MemoryFiles): unknown {
  return JSON.parse(files.get(PLACES.claims) ?? 'null');
}

describe('claimRefusal', () => {
  it('passes a freeze on known targets within the longest freeze', () => {
    assert.equal(claimRefusal(REQUEST, RULES), undefined);
  });

  it('refuses a freeze that is too long or empty, names no or an unknown target, or lacks a metric or reason', () => {
    assert.equal(claimRefusal({ ...REQUEST, minutes: 121 }, RULES), 'a freeze lasts 1 to 120 minutes (asked 121)');
    assert.equal(claimRefusal({ ...REQUEST, minutes: 0 }, RULES), 'a freeze lasts 1 to 120 minutes (asked 0)');
    assert.equal(claimRefusal({ ...REQUEST, targets: [] }, RULES), 'a freeze names at least one deploy target');
    assert.equal(claimRefusal({ ...REQUEST, targets: ['api', 'cloud-web'] }, RULES), 'cloud-web is not a deploy target of this team (known: api, discovery, cloud-api)');
    assert.equal(claimRefusal({ ...REQUEST, targets: ['x', 'y'] }, { ...RULES, knownTargets: [] }), 'x, y are not deploy targets of this team (none are configured)');
    assert.equal(claimRefusal({ ...REQUEST, metric: ' ' }, RULES), 'a freeze names the metric it measures');
    assert.equal(claimRefusal({ ...REQUEST, why: '\n' }, RULES), 'a freeze says why it holds deploys');
  });

  it('refuses a secret in the metric or reason, since the freezes are shared files', () => {
    const why = ['probe with password', '=', 'hunter2'].join('');
    assert.equal(claimRefusal({ ...REQUEST, why }, RULES), 'the reason looks like it holds a secret (password or key assignment); refer to where it is kept instead');
  });
});

describe('addClaim', () => {
  it('adds the freeze from now, drops ended ones, and writes both files in the coordinator’s format', async () => {
    const { files, ports } = world({ [PLACES.claims]: JSON.stringify(HELD) });
    const outcome = await addClaim(ports, PLACES, RULES, REQUEST);
    const claim = { session: 'po', targets: ['api', 'discovery'], metric: 'p95 latency', why: 'measuring the new cache', from: '2030-01-08T10:00:00.000Z', until: '2030-01-08T10:45:00.000Z' };
    assert.deepEqual(outcome, { kind: 'done', value: claim });
    assert.equal(files.get(PLACES.claims), `${JSON.stringify([HELD[0], claim], null, 2)}\n`);
    assert.equal(
      files.get(PLACES.claimsMd),
      [
        '# Quiet claims: active only until their end time (see README.md, rule 3)',
        '- 2030-01-08 09:30 → 2030-01-08 10:30 | web | cloud-api | LCP | image change',
        '- 2030-01-08 10:00 → 2030-01-08 10:45 | po | api,discovery | p95 latency | measuring the new cache',
        '',
      ].join('\n'),
    );
    assert.equal(files.get(LOCK), undefined, 'the claims lock is released');
  });

  it('refuses a second freeze by the same session, naming when its freeze ends', async () => {
    const { files, ports } = world({ [PLACES.claims]: JSON.stringify(HELD) });
    const outcome = await addClaim(ports, PLACES, RULES, { ...REQUEST, session: 'web' });
    assert.deepEqual(outcome, { kind: 'refused', reason: 'web already holds a freeze until 2030-01-08 10:30 UTC; unfreeze it first (one per session)' });
    assert.equal(files.get(PLACES.claims), JSON.stringify(HELD), 'nothing is written');
    assert.equal(files.get(LOCK), undefined);
  });

  it('leaves an unreadable freezes file as it is', async () => {
    const { files, ports } = world({ [PLACES.claims]: '[{"session":' });
    const outcome = await addClaim(ports, PLACES, RULES, REQUEST);
    assert.deepEqual(outcome, { kind: 'refused', reason: '/team/deploys/claims.json is unreadable (not JSON), so it is left as it is' });
    assert.equal(files.get(PLACES.claims), '[{"session":');
  });

  it('is busy, writing nothing, while another writer holds the freezes past the wait', async () => {
    const other = JSON.stringify({ token: 'dc', pid: 9, session: 'claims', purpose: 'claims write', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:59:50.000Z', expiresAt: '2030-01-08T10:00:50.000Z' });
    const { files, clock, ports } = world({ [LOCK]: other });
    const outcome = await addClaim(ports, PLACES, RULES, REQUEST);
    assert.deepEqual(outcome, { kind: 'busy', reason: 'the freezes are being written (claims (claims write) since 2030-01-08 09:59 UTC); try again' });
    assert.equal(clock.now(), Date.parse('2030-01-08T10:00:15Z'), 'it waited the 15 s');
    assert.equal(files.get(PLACES.claims), undefined);
    assert.equal(files.get(LOCK), other, 'the other writer’s lock stays');
  });

  it('is busy, writing nothing, when its place in line for the freezes was withdrawn', async () => {
    const { files, ports } = world();
    const released: HostLockInfo[] = [];
    const outcome = await addClaim({ ...ports, lock: withdrawnLock(released) }, PLACES, RULES, REQUEST);
    assert.deepEqual([outcome, released, files.get(PLACES.claims)], [{ kind: 'busy', reason: 'its place in line for the freezes was withdrawn; try again' }, [], undefined]);
  });

  it('refuses before taking the lock when the request itself is refused', async () => {
    const { files, ports } = world();
    assert.equal((await addClaim(ports, PLACES, RULES, { ...REQUEST, minutes: 500 })).kind, 'refused');
    assert.equal(files.get(PLACES.claimsMd), undefined);
  });
});

describe('releaseClaim', () => {
  it('ends the session’s freeze and returns it, dropping ended ones', async () => {
    const { files, ports } = world({ [PLACES.claims]: JSON.stringify(HELD) });
    assert.deepEqual(await releaseClaim(ports, PLACES, 'web'), { kind: 'done', value: HELD[0] });
    assert.deepEqual(claimsIn(files), []);
    assert.equal(files.get(PLACES.claimsMd), '# Quiet claims: active only until their end time (see README.md, rule 3)\n');
  });

  it('is done with no freeze when the session held none', async () => {
    const { files, ports } = world({ [PLACES.claims]: JSON.stringify(HELD) });
    assert.deepEqual(await releaseClaim(ports, PLACES, 'po'), { kind: 'done', value: undefined });
    assert.deepEqual(claimsIn(files), [HELD[0]]);
  });
});

describe('renderClaimsMd', () => {
  it('shows a time that does not parse as it is', () => {
    assert.equal(renderClaimsMd([{ ...HELD[1]!, from: 'soon' }]).split('\n')[1], '- soon → 2030-01-08 09:00 | ops | api | cpu | old');
  });
});
