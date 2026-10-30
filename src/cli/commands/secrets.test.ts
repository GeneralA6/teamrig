import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CommitAdds } from '../../secret-guard/git-adds.ts';
import { APP, CliHarness, TEAM, type CliResult } from '../../testing/cli-harness.ts';
import { FakeSecretsGit } from '../../testing/fake-secrets-git.ts';

// Credential-shaped fixtures are built at run time, so no secret shape sits in this file.
const glue = (...parts: string[]): string => parts.join('');
const TOKEN = glue('gh', 'p_', 'a1'.repeat(18));
const TEAM_SECRET = glue('acme', '_', '3f9c2b7e1d4a');
const BASE = '1c'.repeat(20);
const TIP = '2d'.repeat(20);
const SIDE = '3e'.repeat(20);
const ZERO = '0'.repeat(40);
const MESSAGE = join(APP, '.git', 'COMMIT_EDITMSG');

const added = (paths: readonly string[], lines: readonly { file: string; line: number; text: string }[] = []) => ({ paths, lines });
const commit = (sha: string, message: string, adds = added([])): CommitAdds => ({ sha, message, ...adds });
const output = (result: CliResult): string => [...result.stdout, ...result.stderr].join('\n');

function repoStaging(paths: readonly string[], lines: readonly { file: string; line: number; text: string }[] = []): FakeSecretsGit {
  const git = new FakeSecretsGit(APP);
  git.index = added(paths, lines);
  return git;
}

describe('teamrig secrets staged', () => {
  it('passes a staged change with no secret and counts its files', async () => {
    const result = await new CliHarness().run(['secrets', 'staged'], { secretsGit: repoStaging(['src/a.ts'], [{ file: 'src/a.ts', line: 1, text: 'const port = 8080;' }]) });

    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, ['OK no secret in the staged change (1 file(s))']);
  });

  it('refuses a staged secret line and a declared secret file by place and shape, never printing the value', async () => {
    const git = repoStaging(['.env', 'src/a.ts'], [{ file: 'src/a.ts', line: 3, text: `  ${TOKEN},` }]);

    const result = await new CliHarness().run(['secrets', 'staged'], { secretsGit: git });

    assert.equal(result.code, 2);
    const text = output(result);
    assert.match(text, /^REFUSED the staged change adds 2 secret\(s\), named by place and shape, never by value:/);
    assert.match(text, /\n {2}\.env: a declared secret file\n/);
    assert.match(text, /\n {2}src\/a\.ts:3: GitHub token\n/);
    assert.match(text, /Fix: unstage it, read the value by reference .* rotate it\.$/);
    assert.equal(text.includes(TOKEN), false);
  });

  it('scans with the default shapes and paths outside a team, and with a config it cannot read', async () => {
    for (const kit of [new CliHarness(null, null), new CliHarness('{ not json')]) {
      const result = await kit.run(['secrets', 'staged'], { secretsGit: repoStaging(['config/.env'], [{ file: 'b.ts', line: 1, text: TOKEN }]) });

      assert.equal(result.code, 2, output(result));
      assert.match(output(result), /config\/\.env: a declared secret file/);
      assert.match(output(result), /b\.ts:1: GitHub token/);
    }
  });

  it("adds the team's own secret paths and patterns inside a team", async () => {
    const kit = new CliHarness({ ...TEAM, secretGuard: { paths: ['deploy/keys/**'] }, register: { secretPatterns: ['acme_[0-9a-f]{12}'] } });
    const git = repoStaging(['deploy/keys/prod'], [{ file: 'c.ts', line: 7, text: `const id = '${TEAM_SECRET}';` }]);

    const result = await kit.run(['secrets', 'staged'], { secretsGit: git });

    assert.equal(result.code, 2, output(result));
    assert.match(output(result), /deploy\/keys\/prod: a declared secret file/);
    assert.match(output(result), /c\.ts:7: secret pattern from the team config/);
    assert.equal(output(result).includes(TEAM_SECRET), false);
  });

  it('fails outside a repository and on an index git cannot read, so no commit passes unread', async () => {
    const outside = await new CliHarness().run(['secrets', 'staged'], { secretsGit: new FakeSecretsGit(undefined) });
    const unreadable = repoStaging([]);
    unreadable.index = undefined;
    const broken = await new CliHarness().run(['secrets', 'staged'], { secretsGit: unreadable });

    assert.equal(outside.code, 1);
    assert.match(output(outside), /is not in a git repository/);
    assert.equal(broken.code, 1);
    assert.match(output(broken), /git cannot read the staged change in /);
  });
});

describe('teamrig secrets message', () => {
  it('refuses a secret above the cut line by its message line, and passes one below it', async () => {
    const kit = new CliHarness();
    await kit.files.write(MESSAGE, `subject\n\nuse ${TOKEN}\n`);
    const refused = await kit.run(['secrets', 'message', '.git/COMMIT_EDITMSG']);
    await kit.files.write(MESSAGE, `subject\n# ------------------------ >8 ------------------------\n+${TOKEN}\n`);
    const passed = await kit.run(['secrets', 'message', MESSAGE]);

    assert.equal(refused.code, 2);
    assert.match(output(refused), /^REFUSED the commit message holds 1 secret\(s\)/);
    assert.match(output(refused), /\n {2}commit message line 3: GitHub token\n/);
    assert.match(output(refused), /Fix: take it out of the message; /);
    assert.equal(output(refused).includes(TOKEN), false);
    assert.equal(passed.code, 0);
    assert.deepEqual(passed.stdout, ['OK no secret in the commit message']);
  });

  it('fails on a message file that is not there, and needs a file', async () => {
    const missing = await new CliHarness().run(['secrets', 'message', 'NOPE']);
    const bare = await new CliHarness().run(['secrets', 'message']);

    assert.equal(missing.code, 1);
    assert.match(output(missing), /no commit message file at .*NOPE/);
    assert.equal(bare.code, 64);
  });
});

describe('teamrig secrets pushed', () => {
  it("reads each ref's range, scans a commit two refs send once, and skips a delete", async () => {
    const git = new FakeSecretsGit(APP);
    git.known.add(BASE);
    const shared = commit(TIP, 'shared\n');
    git.logs.set(`${BASE}..${TIP}`, [shared]);
    git.logs.set(`${SIDE} --not --remotes=origin`, [commit(SIDE, 'side\n'), shared]);
    const stdin = [
      `refs/heads/main ${TIP} refs/heads/main ${BASE}`,
      `refs/heads/side ${SIDE} refs/heads/side ${ZERO}`,
      `(delete) ${ZERO} refs/heads/old ${BASE}`,
      '',
    ].join('\n');

    const result = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: git, stdin });

    assert.equal(result.code, 0, output(result));
    assert.deepEqual(result.stdout, ['OK no secret in the 2 commit(s) pushed to origin']);
    assert.deepEqual(git.read, [`${BASE}..${TIP}`, `${SIDE} --not --remotes=origin`]);
  });

  it("refuses a pushed commit's secret by its short id, file and line", async () => {
    const git = new FakeSecretsGit(APP);
    git.logs.set(`${TIP} --not --remotes=origin`, [commit(TIP, 'add key\n', added(['a.ts'], [{ file: 'a.ts', line: 2, text: TOKEN }]))]);

    const result = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: git, stdin: `refs/heads/main ${TIP} refs/heads/main ${BASE}\n` });

    assert.equal(result.code, 2);
    assert.match(output(result), /^REFUSED the push to origin adds 1 secret\(s\)/);
    assert.match(output(result), /\n {2}2d2d2d2 a\.ts:2: GitHub token\n/);
    assert.match(output(result), /Fix: rewrite those commits or tags without it before the push, /);
    assert.equal(output(result).includes(TOKEN), false);
  });

  it("refuses a secret in a pushed annotated tag's message by the tag's short id and line, and counts a clean push's tags once", async () => {
    const tag = '4f'.repeat(20);
    const git = new FakeSecretsGit(APP);
    git.logs.set(`${tag} --not --remotes=origin`, [commit(TIP, 'tagged\n')]);
    git.tags.set(tag, [{ sha: tag, message: `v1\n\nsee ${TOKEN}\n` }]);
    const line = `refs/tags/v1 ${tag} refs/tags/v1 ${ZERO}\n`;

    const refused = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: git, stdin: line });
    git.tags.set(tag, [{ sha: tag, message: 'v1\n' }]);
    const passed = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: git, stdin: `${line}refs/tags/copy ${tag} refs/tags/copy ${ZERO}\n` });

    assert.equal(refused.code, 2);
    assert.match(output(refused), /^REFUSED the push to origin adds 1 secret\(s\)/);
    assert.match(output(refused), /\n {2}4f4f4f4 tag message line 3: GitHub token\n/);
    assert.equal(output(refused).includes(TOKEN), false);
    assert.equal(passed.code, 0, output(passed));
    assert.deepEqual(passed.stdout, ['OK no secret in the 1 commit(s) and 1 tag message(s) pushed to origin']);
  });

  it('fails on a range git cannot list, a tag git cannot read, a line git would not write, and outside a repository', async () => {
    const listing = new FakeSecretsGit(APP);
    listing.logFails = true;
    const tagging = new FakeSecretsGit(APP);
    tagging.tagFails = true;
    const line = `refs/heads/main ${TIP} refs/heads/main ${ZERO}\n`;

    const unlisted = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: listing, stdin: line });
    const untagged = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: tagging, stdin: line });
    const garbled = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: new FakeSecretsGit(APP), stdin: 'refs/heads/main HEAD\n' });
    const outside = await new CliHarness().run(['secrets', 'pushed', 'origin'], { secretsGit: new FakeSecretsGit(undefined), stdin: line });

    assert.equal(unlisted.code, 1);
    assert.match(output(unlisted), new RegExp(`git cannot list the commits ${TIP} --not --remotes=origin in .*needs git 2\\.36 or later`));
    assert.equal(untagged.code, 1);
    assert.match(output(untagged), new RegExp(`git cannot read the object ${TIP} in .*, or it is a tag of more than 8 tags`));
    assert.equal(garbled.code, 1);
    assert.match(output(garbled), /pre-push line 1 is not/);
    assert.equal(outside.code, 1);
    assert.match(output(outside), /is not in a git repository/);
  });

  it('needs a remote that is not empty', async () => {
    const empty = await new CliHarness().run(['secrets', 'pushed', ''], { secretsGit: new FakeSecretsGit(APP), stdin: '' });
    const bare = await new CliHarness().run(['secrets', 'pushed'], { secretsGit: new FakeSecretsGit(APP), stdin: '' });

    assert.equal(empty.code, 64);
    assert.equal(bare.code, 64);
  });
});
