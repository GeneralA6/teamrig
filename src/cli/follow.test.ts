import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { FOLLOWS_FORMAT } from '../github/follows.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const FOLLOW_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'], followMax: 2 } };
const FOLLOWS_PATH = join(TEAM_HOME, 'state', 'github-follows.json');
const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_BRAVO = { env: { TEAMRIG_SESSION: 'bravo' } };

/** Runs `argv` as `as`, failing the test unless it ends with `code`, and returns what it printed. */
async function ran(kit: CliHarness, argv: readonly string[], as: { readonly env: Readonly<Record<string, string>> }, code: number): Promise<string[]> {
  const result = await kit.run(argv, as);
  assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
  return [...result.stdout, ...result.stderr];
}

describe('teamrig follow and unfollow', () => {
  it('follows an item of github.repos per session, lists it, tells a repeat, and unfollows it', async () => {
    const kit = new CliHarness(FOLLOW_TEAM);
    assert.deepEqual(await ran(kit, ['follow', '--list'], AS_ALPHA, EXIT.ok), ['FOLLOWING nothing: teamrig follow <owner/name#n> follows an issue or pull request']);
    assert.match((await ran(kit, ['follow', 'Acme/Web#7'], AS_ALPHA, EXIT.ok))[0] ?? '', /^FOLLOWING gh:acme\/web#7: its new comments, reviews, CI results/);
    assert.deepEqual(await ran(kit, ['follow', 'gh:acme/web#7'], AS_ALPHA, EXIT.ok), ['FOLLOWING gh:acme/web#7 already']);
    await ran(kit, ['follow', 'acme/api#2'], AS_ALPHA, EXIT.ok);
    await ran(kit, ['follow', 'acme/web#7'], AS_BRAVO, EXIT.ok);
    assert.deepEqual(await ran(kit, ['follow', '--list'], AS_ALPHA, EXIT.ok), ['FOLLOWING gh:acme/web#7', 'FOLLOWING gh:acme/api#2']);
    assert.equal(kit.files.get(FOLLOWS_PATH), `{"v":${FOLLOWS_FORMAT},"follows":{"alpha":["gh:acme/web#7","gh:acme/api#2"],"bravo":["gh:acme/web#7"]}}\n`);
    assert.deepEqual(await ran(kit, ['unfollow', 'acme/web#7'], AS_ALPHA, EXIT.ok), ['UNFOLLOWED gh:acme/web#7']);
    assert.deepEqual(await ran(kit, ['follow', '--list'], AS_ALPHA, EXIT.ok), ['FOLLOWING gh:acme/api#2']);
    assert.deepEqual(await ran(kit, ['follow', '--list'], AS_BRAVO, EXIT.ok), ['FOLLOWING gh:acme/web#7']);
  });

  it('refuses a follow past github.followMax, of a repository the sync does not read, and an unfollow of what is not followed', async () => {
    const kit = new CliHarness(FOLLOW_TEAM);
    await ran(kit, ['follow', 'acme/web#1'], AS_ALPHA, EXIT.ok);
    await ran(kit, ['follow', 'acme/web#2'], AS_ALPHA, EXIT.ok);
    assert.match((await ran(kit, ['follow', 'acme/web#3'], AS_ALPHA, EXIT.refused)).join('\n'), /you follow 2 issues and pull requests, the most github\.followMax allows/);
    assert.match((await ran(kit, ['follow', 'other/lib#3'], AS_BRAVO, EXIT.refused)).join('\n'), /other\/lib is not one of github\.repos/);
    assert.match((await ran(kit, ['unfollow', 'acme/web#9'], AS_ALPHA, EXIT.refused)).join('\n'), /you do not follow gh:acme\/web#9/);
    assert.deepEqual(await ran(kit, ['follow', '--list'], AS_BRAVO, EXIT.ok), ['FOLLOWING nothing: teamrig follow <owner/name#n> follows an issue or pull request']);
  });

  it('refuses every follow while github.activity is off or github.followMax is 0', async () => {
    const off = new CliHarness({ ...TEAM, github: { repos: ['acme/web'], activity: false } });
    assert.match((await ran(off, ['follow', 'acme/web#1'], AS_ALPHA, EXIT.refused)).join('\n'), /github\.activity is off/);
    const none = new CliHarness({ ...TEAM, github: { repos: ['acme/web'], followMax: 0 } });
    assert.match((await ran(none, ['follow', 'acme/web#1'], AS_ALPHA, EXIT.refused)).join('\n'), /github\.followMax is 0/);
    assert.equal(none.files.get(FOLLOWS_PATH), undefined);
  });

  it('takes an item only as owner/name#n, and refuses a follows file a newer teamrig wrote', async () => {
    const kit = new CliHarness(FOLLOW_TEAM);
    assert.match((await ran(kit, ['follow', 'acme/web'], AS_ALPHA, EXIT.usage)).join('\n'), /names no issue or pull request: give it as owner\/name#n/);
    await ran(kit, ['follow'], AS_ALPHA, EXIT.usage);
    await ran(kit, ['follow', '--list', 'acme/web#1'], AS_ALPHA, EXIT.usage);
    const newer = `{"v":${FOLLOWS_FORMAT + 1},"follows":{}}\n`;
    await kit.files.write(FOLLOWS_PATH, newer);
    assert.notEqual((await kit.run(['follow', 'acme/web#1'], AS_ALPHA)).code, EXIT.ok);
    assert.equal(kit.files.get(FOLLOWS_PATH), newer);
  });
});
