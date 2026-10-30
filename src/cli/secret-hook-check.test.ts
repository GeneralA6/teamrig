import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { FakeSecretsGit } from '../testing/fake-secrets-git.ts';
import { EXIT } from './runtime.ts';
import { callsSecretScan, hookScriptsDir, SECRET_HOOKS } from './secret-hook-check.ts';

const API = resolve('/', 'r', 'api');
const WEB = resolve('/', 'r', 'web');
const REPOS = { ...TEAM, delivery: { repos: { api: { mainCheckout: API }, web: { mainCheckout: WEB } } } };
const SOURCE = 'from the secret hook check [delivery.repos]: SECRET-HOOK';
const LINES = {
  'pre-commit': '`teamrig secrets staged || exit 1` to pre-commit',
  'commit-msg': '`teamrig secrets message "$1" || exit 1` to commit-msg',
  'pre-push': '`teamrig secrets pushed "$1" || exit 1` to pre-push',
} as const;

/** The scripts that run the scan in every hook: the `teamrig` command, or teamrig's own source in its repository. */
const GUARDED = {
  'pre-commit': '#!/bin/sh\nnode src/cli/main.ts secrets staged || exit 1\n',
  'commit-msg': '#!/bin/sh\nteamrig secrets message "$1" || exit 1\n',
  'pre-push': '#!/bin/sh\nnpx teamrig secrets pushed "$1" || exit 1\n',
} as const;

/** A git that finds each repository's hooks in the folder given. */
function gitWithHooks(dirs: Readonly<Record<string, string>>): FakeSecretsGit {
  const git = new FakeSecretsGit(undefined);
  Object.entries(dirs).forEach(([main, hooks]) => git.hookDirs.set(main, hooks));
  return git;
}

async function writeHooks(kit: CliHarness, dir: string, hooks: Partial<Record<keyof typeof GUARDED, string>>): Promise<void> {
  for (const [hook, text] of Object.entries(hooks)) {
    await kit.files.write(join(dir, hook), text);
  }
}

/** The lead's check rows from the secret hook check. */
async function hookRows(kit: CliHarness, secretsGit: FakeSecretsGit): Promise<string[]> {
  const result = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' }, secretsGit });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the secret hook check'));
}

describe('check SECRET-HOOK (T1480)', () => {
  it('flags a repository whose hooks lack the scan, with the line to add to each, and passes one whose hooks run it', async () => {
    const kit = new CliHarness(REPOS);
    const apiHooks = join(API, '.git', 'hooks');
    const webHooks = join(WEB, '.githooks');
    await writeHooks(kit, apiHooks, { 'pre-commit': '#!/bin/sh\nnpm test\n', 'commit-msg': '#!/bin/sh\n# teamrig secrets message is not run here\n' });
    await writeHooks(kit, webHooks, GUARDED);
    assert.deepEqual(await hookRows(kit, gitWithHooks({ [API]: apiHooks, [WEB]: webHooks })), [
      `${SOURCE} api (${apiHooks}) runs no secret scan in pre-commit, commit-msg, pre-push, so a secret there can be committed or pushed: add ${LINES['pre-commit']}, ${LINES['commit-msg']}, ${LINES['pre-push']}`,
    ]);
  });

  it("reads husky's scripts in .husky, not the stubs in the .husky/_ folder git runs", async () => {
    const kit = new CliHarness(REPOS);
    const husky = join(API, '.husky');
    await writeHooks(kit, join(husky, '_'), { 'pre-commit': '#!/bin/sh\n. "${0%/*}/h"\n', 'pre-push': '#!/bin/sh\n. "${0%/*}/h"\n' });
    await writeHooks(kit, husky, { 'pre-commit': GUARDED['pre-commit'], 'commit-msg': GUARDED['commit-msg'] });
    const webHooks = join(WEB, '.git', 'hooks');
    await writeHooks(kit, webHooks, GUARDED);
    assert.deepEqual(await hookRows(kit, gitWithHooks({ [API]: join(husky, '_'), [WEB]: webHooks })), [
      `${SOURCE} api (${husky}) runs no secret scan in pre-push, so a secret there can be committed or pushed: add ${LINES['pre-push']}`,
    ]);
  });

  it('flags a repository git cannot read, as its hooks could not be checked', async () => {
    const kit = new CliHarness(REPOS);
    const webHooks = join(WEB, '.git', 'hooks');
    await writeHooks(kit, webHooks, GUARDED);
    assert.deepEqual(await hookRows(kit, gitWithHooks({ [WEB]: webHooks })), [
      `${SOURCE} api (${API}): git reads no repository there, so its hooks could not be checked for the secret scan`,
    ]);
  });

  it('flags nothing for a team with no repositories', async () => {
    assert.deepEqual(await hookRows(new CliHarness(TEAM), new FakeSecretsGit(undefined)), []);
  });

  it("tells the lead once from any session's start, while the hooks still lack the scan", async () => {
    const kit = new CliHarness({ ...TEAM, delivery: { repos: { api: { mainCheckout: API } } } });
    const options: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' }, secretsGit: gitWithHooks({ [API]: join(API, '.git', 'hooks') }) };
    for (let run = 0; run < 2; run += 1) {
      assert.equal((await kit.run(['start'], options)).code, EXIT.ok);
    }
    const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
    const lines = inbox.split('\n').filter((line) => line.includes('the secret hook check [delivery.repos] raised a warning no session owns'));
    assert.equal(lines.length, 1, inbox);
    assert.match(lines[0] ?? '', /so it is yours as lead: SECRET-HOOK api \(/);
  });
});

describe('callsSecretScan', () => {
  it('needs the hook\'s own subcommand, called through teamrig or its source', () => {
    const [preCommit] = SECRET_HOOKS;
    assert.ok(preCommit !== undefined);
    const cases = [
      ['teamrig secrets staged || exit 1', true],
      ['exec npx teamrig  secrets staged', true],
      ['node src/cli/main.ts secrets staged', true],
      ['teamrig secrets message "$1"', false],
      ['teamrig secrets stagedx', false],
      ['other-teamrig-tool secrets staged', false],
      ['secrets staged', false],
      ['#!/bin/sh\n  # teamrig secrets staged\nnpm test', false],
      ['#!/bin/sh\nnpm test\nteamrig secrets staged', true],
    ] as const;
    for (const [script, calls] of cases) {
      assert.equal(callsSecretScan(script, preCommit), calls, script);
    }
  });
});

describe('hookScriptsDir', () => {
  it("is husky's .husky for its .husky/_, else the hooks folder itself", () => {
    assert.equal(hookScriptsDir(join('/', 'r', '.husky', '_')), join('/', 'r', '.husky'));
    assert.equal(hookScriptsDir(join('/', 'r', 'hooks', '_')), join('/', 'r', 'hooks', '_'));
    assert.equal(hookScriptsDir(join('/', 'r', '.git', 'hooks')), join('/', 'r', '.git', 'hooks'));
  });
});
