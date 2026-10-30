import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { EXIT } from './runtime.ts';

const CLAIMS = join(TEAM_HOME, 'state', 'deploys', 'claims.json');
const DEPLOYING = { ...TEAM, delivery: { freezes: { maxMinutes: 120 }, repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-api'] } } } };

/** The flags of a freeze by alpha on cloud-api for 1h30m, with `flags` instead. */
function freezeFlags(flags: Readonly<Record<string, string>> = {}): string[] {
  const all = { session: 'alpha', targets: 'cloud-api', metric: 'p95 latency', why: 'cache probe', for: '1h30m', ...flags };
  return Object.entries(all).flatMap(([name, value]) => [`--${name}`, value]);
}

/** `teamrig freeze` by alpha on cloud-api for 1h30m, with `flags` instead. */
function freezeArgs(flags: Readonly<Record<string, string>> = {}): string[] {
  return ['freeze', ...freezeFlags(flags)];
}

function freezesIn(kit: CliHarness): unknown {
  return JSON.parse(kit.files.get(CLAIMS) ?? 'null');
}

describe('teamrig freeze', () => {
  it('freezes the targets from now for the span and prints FROZEN', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.deepEqual(await kit.run(freezeArgs()), { code: 0, stdout: ['FROZEN cloud-api until 2030-01-08 11:30 UTC'], stderr: [] });
    assert.deepEqual(freezesIn(kit), [
      { session: 'alpha', targets: ['cloud-api'], metric: 'p95 latency', why: 'cache probe', from: '2030-01-08T10:00:00.000Z', until: '2030-01-08T11:30:00.000Z' },
    ]);
  });

  it('refuses a target no repository deploys, a span past delivery.freezes.maxMinutes and a second freeze', async () => {
    const kit = new CliHarness({ ...DEPLOYING, delivery: { ...DEPLOYING.delivery, freezes: { maxMinutes: 60 } } });
    assert.deepEqual(await kit.run(freezeArgs({ targets: 'api', for: '45m' })), { code: 2, stdout: ['REFUSED api is not a deploy target of this team (known: cloud-api)'], stderr: [] });
    assert.deepEqual(await kit.run(freezeArgs()), { code: 2, stdout: ['REFUSED a freeze lasts 1 to 60 minutes (asked 90)'], stderr: [] });
    assert.equal(kit.files.get(CLAIMS), undefined, 'nothing is written');
    assert.equal((await kit.run(freezeArgs({ for: '45m' }))).code, 0);
    assert.deepEqual(await kit.run(freezeArgs({ for: '10m' })), {
      code: 2,
      stdout: ['REFUSED alpha already holds a freeze until 2030-01-08 10:45 UTC; unfreeze it first (one per session)'],
      stderr: [],
    });
  });

  it('is a usage error for a span it cannot read', async () => {
    const kit = new CliHarness(DEPLOYING);
    const result = await kit.run(freezeArgs({ for: '90s' }));
    assert.equal(result.code, 64);
    assert.ok([...result.stdout, ...result.stderr].some((line) => line.includes('--for "90s" is not a span')), JSON.stringify(result));
    assert.equal(kit.files.get(CLAIMS), undefined);
  });

  it('refuses teamrig claim, its old name, with the new one and exit 64, freezing nothing', async () => {
    const kit = new CliHarness(DEPLOYING);
    const result = await kit.run(['claim', ...freezeFlags()]);
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'claim was renamed: use freeze']);
    assert.equal(kit.files.get(CLAIMS), undefined);
  });
});

describe('teamrig unfreeze', () => {
  it('ends this session’s freeze, and says NONE when it holds none', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.equal((await kit.run(freezeArgs())).code, 0);
    assert.deepEqual(await kit.run(['unfreeze', '--session', 'alpha']), { code: 0, stdout: ['UNFROZEN cloud-api (frozen until 2030-01-08 11:30 UTC)'], stderr: [] });
    assert.deepEqual(await kit.run(['unfreeze', '--session', 'alpha']), { code: 0, stdout: ['NONE this session held no freeze'], stderr: [] });
    assert.deepEqual(freezesIn(kit), []);
  });

  it('refuses teamrig release, its old name, with the new one and exit 64, ending no freeze', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.equal((await kit.run(freezeArgs())).code, 0);
    const result = await kit.run(['release', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'release was renamed: use unfreeze']);
    const held = freezesIn(kit);
    assert.ok(Array.isArray(held) && held.length === 1, JSON.stringify(held));
  });
});
