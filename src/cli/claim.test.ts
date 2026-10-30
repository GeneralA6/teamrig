import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';

const CLAIMS = join(TEAM_HOME, 'state', 'deploys', 'claims.json');
const DEPLOYING = { ...TEAM, delivery: { freezes: { maxMinutes: 120 }, repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-api'] } } } };

/** `teamrig claim` by alpha on cloud-api for 1h30m, with `flags` instead. */
function claimArgs(flags: Readonly<Record<string, string>> = {}): string[] {
  const all = { session: 'alpha', targets: 'cloud-api', metric: 'p95 latency', why: 'cache probe', for: '1h30m', ...flags };
  return ['claim', ...Object.entries(all).flatMap(([name, value]) => [`--${name}`, value])];
}

function claimsIn(kit: CliHarness): unknown {
  return JSON.parse(kit.files.get(CLAIMS) ?? 'null');
}

describe('teamrig claim', () => {
  it('claims the targets from now for the span and prints CLAIMED', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.deepEqual(await kit.run(claimArgs()), { code: 0, stdout: ['CLAIMED cloud-api until 2030-01-08 11:30 UTC'], stderr: [] });
    assert.deepEqual(claimsIn(kit), [
      { session: 'alpha', targets: ['cloud-api'], metric: 'p95 latency', why: 'cache probe', from: '2030-01-08T10:00:00.000Z', until: '2030-01-08T11:30:00.000Z' },
    ]);
  });

  it('refuses a target no repository deploys, a span past delivery.freezes.maxMinutes and a second claim', async () => {
    const kit = new CliHarness({ ...DEPLOYING, delivery: { ...DEPLOYING.delivery, freezes: { maxMinutes: 60 } } });
    assert.deepEqual(await kit.run(claimArgs({ targets: 'api', for: '45m' })), { code: 2, stdout: ['REFUSED api is not a deploy target of this team (known: cloud-api)'], stderr: [] });
    assert.deepEqual(await kit.run(claimArgs()), { code: 2, stdout: ['REFUSED a claim lasts 1 to 60 minutes (asked 90)'], stderr: [] });
    assert.equal(kit.files.get(CLAIMS), undefined, 'nothing is written');
    assert.equal((await kit.run(claimArgs({ for: '45m' }))).code, 0);
    assert.deepEqual(await kit.run(claimArgs({ for: '10m' })), {
      code: 2,
      stdout: ['REFUSED alpha already holds a claim until 2030-01-08 10:45 UTC; release it first (one per session)'],
      stderr: [],
    });
  });

  it('is a usage error for a span it cannot read', async () => {
    const kit = new CliHarness(DEPLOYING);
    const result = await kit.run(claimArgs({ for: '90s' }));
    assert.equal(result.code, 64);
    assert.ok([...result.stdout, ...result.stderr].some((line) => line.includes('--for "90s" is not a span')), JSON.stringify(result));
    assert.equal(kit.files.get(CLAIMS), undefined);
  });
});

describe('teamrig release', () => {
  it('ends this session’s claim, and says NONE when it holds none', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.equal((await kit.run(claimArgs())).code, 0);
    assert.deepEqual(await kit.run(['release', '--session', 'alpha']), { code: 0, stdout: ['RELEASED cloud-api (claimed until 2030-01-08 11:30 UTC)'], stderr: [] });
    assert.deepEqual(await kit.run(['release', '--session', 'alpha']), { code: 0, stdout: ['NONE this session held no claim'], stderr: [] });
    assert.deepEqual(claimsIn(kit), []);
  });
});
