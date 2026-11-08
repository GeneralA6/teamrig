import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CLAUDE_SESSION, CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeWorktreeFiles, FakeWorktreeGit, type FakeGitAnswers } from '../testing/fake-worktrees.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import { EXIT } from './runtime.ts';

const MODULES = '/w/main/node_modules';

/** A clean worktree at /w/t4 on branch t4, whose node_modules links to the main checkout's two packages. */
function worktrees(answers: FakeGitAnswers = {}): { files: FakeWorktreeFiles; git: FakeWorktreeGit; ports: WorktreePorts } {
  const files = new FakeWorktreeFiles({
    [`${MODULES}/pkg`]: { kind: 'folder' },
    [`${MODULES}/keep.txt`]: { kind: 'file' },
    '/w/t4/src/index.ts': { kind: 'file' },
    '/w/t4/node_modules': { kind: 'link', target: MODULES },
  });
  const git = new FakeWorktreeGit(
    {
      top: '/w/t4',
      worktrees: [
        { path: '/w/main', branch: 'main', locked: undefined },
        { path: '/w/t4', branch: 't4', locked: undefined },
      ],
      changes: [],
      tracked: ['src/index.ts'],
      defaultBase: 'origin/main',
      commitsNotOn: 0,
      ...answers,
    },
    () => files.delete('/w/t4'),
  );
  return { files, git, ports: { git, files } };
}

describe('runCli: worktree remove', () => {
  it('unlinks the link, removes the worktree and its merged branch, with no team set up', async () => {
    const { git, ports } = worktrees();
    const result = await new CliHarness(null, null).run(['worktree', 'remove', '/w/t4', '--delete-branch'], { worktrees: ports });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      `unlinked node_modules (the link only, to ${resolve(MODULES)})`,
      'removed the worktree /w/t4',
      `target ${resolve(MODULES)} untouched: 2 entries, as before`,
      'deleted branch t4: every commit of it is on origin/main',
      'OK removed /w/t4',
    ]);
    assert.deepEqual(git.steps, ['worktree remove /w/t4 in /w/main', 'branch -D t4 in /w/main']);
  });

  it('prints the steps of a dry run and changes nothing', async () => {
    const { files, git, ports } = worktrees();
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4', '--dry-run'], { worktrees: ports });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      `would unlink node_modules (the link only; its target ${resolve(MODULES)} holds 2 entries)`,
      'would remove the worktree /w/t4',
      'dry run: nothing changed',
    ]);
    assert.deepEqual(files.unlinked, []);
    assert.deepEqual(git.steps, []);
  });

  it('refuses an unsafe removal before any change', async () => {
    const { files, git, ports } = worktrees({ changes: ['src/index.ts'] });
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, ['REFUSED /w/t4 has uncommitted changes or untracked files (src/index.ts): commit or remove them first']);
    assert.deepEqual(files.unlinked, []);
    assert.deepEqual(git.steps, []);
  });

  it('resolves a relative path against the folder it runs in', async () => {
    const { ports } = worktrees();
    const result = await new CliHarness().run(['worktree', 'remove', 't4', '--dry-run'], { worktrees: ports, cwd: '/w' });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
  });

  it('fails when git refuses the removal, naming the links it put back', async () => {
    const { ports } = worktrees({ removal: { ok: false, reason: 'fatal: busy' } });
    const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stderr.join('\n'), /git worktree remove \/w\/t4: fatal: busy \(its links are back: node_modules\)/);
  });

  it('needs a path, and --base only with --delete-branch', async () => {
    const kit = new CliHarness();
    assert.equal((await kit.run(['worktree', 'remove'])).code, EXIT.usage);
    const base = await kit.run(['worktree', 'remove', '/w/t4', '--base', 'main'], { worktrees: worktrees().ports });
    assert.equal(base.code, EXIT.usage);
    assert.match(base.stderr.join('\n'), /--base names the branch to check against for --delete-branch/);
  });
});

describe('runCli: worktree remove in a team removes only what the caller may (T1319)', () => {
  /** Team app's worktree /w/t4 on branch t1-parser, T1 being alpha's task. */
  async function teamWorld(): Promise<{ kit: CliHarness; git: FakeWorktreeGit; ports: WorktreePorts }> {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--session', 'lead', '--owner', 'alpha', '--title', 'Parser', '--description', 'Parse the input.', '--priority', 'p1']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const { git, ports } = worktrees({
      worktrees: [
        { path: '/w/main', branch: 'main', locked: undefined },
        { path: '/w/t4', branch: 't1-parser', locked: undefined },
      ],
    });
    return { kit, git, ports };
  }

  it('removes a session its own worktree, named by --session (T1312)', async () => {
    const { kit, git, ports } = await teamWorld();
    const result = await kit.run(['worktree', 'remove', '/w/t4', '--session', 'alpha'], { worktrees: ports, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(git.steps, ['worktree remove /w/t4 in /w/main']);
  });

  it("removes the lead any session's worktree", async () => {
    const { kit, git, ports } = await teamWorld();
    const result = await kit.run(['worktree', 'remove', '/w/t4'], { worktrees: ports, env: { TEAMRIG_SESSION: 'lead', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(git.steps, ['worktree remove /w/t4 in /w/main']);
  });

  it("refuses another session's worktree before any change, naming who may", async () => {
    const { kit, git, ports } = await teamWorld();
    const result = await kit.run(['worktree', 'remove', '/w/t4', '--dry-run'], { worktrees: ports, env: { TEAMRIG_SESSION: 'bravo', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, ["REFUSED the worktree's branch t1-parser is T1's, which alpha owns: only alpha or lead removes it"]);
    assert.deepEqual(git.steps, []);
  });

  describe('a worktree teamrig merge left on a detached HEAD (T1856)', () => {
    const DETACHED = [
      { path: '/w/main', branch: 'main', locked: undefined },
      { path: '/w/t4', branch: undefined, locked: undefined },
    ];
    const BRAVO = { TEAMRIG_SESSION: 'bravo', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION };

    it('any session removes once the default branch holds every commit of its HEAD', async () => {
      const { git, ports } = worktrees({ worktrees: DETACHED, headCommitsNotOn: 0 });
      const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports, env: BRAVO });
      assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
      assert.deepEqual(git.steps, ['worktree remove /w/t4 in /w/main']);
    });

    it('only the lead removes while a commit of its HEAD is not on the default branch', async () => {
      const { git, ports } = worktrees({ worktrees: DETACHED, headCommitsNotOn: 1 });
      const result = await new CliHarness().run(['worktree', 'remove', '/w/t4'], { worktrees: ports, env: BRAVO });
      assert.equal(result.code, EXIT.refused);
      assert.deepEqual(result.stdout, [
        'REFUSED the worktree is on no branch, and git does not show every commit of its HEAD on the default branch (as of the last fetch), so only the lead (lead) removes it: if it merged, fetch and run this again',
      ]);
      assert.deepEqual(git.steps, []);
    });
  });

  it('refuses a Claude Code tab bound to no session, and checks nothing for the person at a terminal', async () => {
    const { kit, git, ports } = await teamWorld();
    const tab = await kit.run(['worktree', 'remove', '/w/t4'], { worktrees: ports, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(tab.code, EXIT.refused);
    assert.deepEqual(tab.stdout, ['REFUSED this Claude Code tab is bound to no session of team app: give --session <id|name>']);
    assert.deepEqual(git.steps, []);
    const person = await kit.run(['worktree', 'remove', '/w/t4'], { worktrees: ports });
    assert.equal(person.code, EXIT.ok, person.stdout.join('\n'));
  });
});

describe('runCli: worktree remove clears the leftover of a removal git stopped partway (T1051)', () => {
  /** A folder git no longer lists at `husk`, holding only its node_modules link; git lists only the main checkout at /w/main. */
  function leftover(husk: string, top: string | undefined): { files: FakeWorktreeFiles; git: FakeWorktreeGit; ports: WorktreePorts } {
    const files = new FakeWorktreeFiles({
      [`${MODULES}/pkg`]: { kind: 'folder' },
      [`${MODULES}/keep.txt`]: { kind: 'file' },
      [`${husk}/node_modules`]: { kind: 'link', target: MODULES },
    });
    const git = new FakeWorktreeGit({ top, worktrees: [{ path: '/w/main', branch: 'main', locked: undefined }], tracked: [] });
    return { files, git, ports: { git, files } };
  }

  it('in the folder worktree add uses in the repository it runs in, with no team set up', async () => {
    const husk = '/w/main/.claude/worktrees/t4';
    const { files, git, ports } = leftover(husk, '/w/main');
    const kit = new CliHarness(null, null);
    const dry = await kit.run(['worktree', 'remove', husk, '--dry-run'], { worktrees: ports });
    assert.equal(dry.code, EXIT.ok, dry.stdout.join('\n'));
    assert.deepEqual(dry.stdout, [
      `would unlink node_modules (the link only; its target ${resolve(MODULES)} holds 2 entries)`,
      `would remove the empty folder ${resolve(husk)}`,
      'dry run: nothing changed',
    ]);
    assert.deepEqual(files.unlinked, []);
    const result = await kit.run(['worktree', 'remove', husk], { worktrees: ports });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(result.stdout, [
      `unlinked node_modules (the link only, to ${resolve(MODULES)})`,
      `target ${resolve(MODULES)} untouched: 2 entries, as before`,
      `removed ${resolve(husk)}`,
      `OK cleared the leftover ${resolve(husk)}`,
    ]);
    assert.deepEqual(git.steps, []);
    assert.equal(await files.kindOf(husk), 'missing');
  });

  it("in a team's delivery.repos worktree folder, for any session: a leftover has no branch to own", async () => {
    const kit = new CliHarness({ ...TEAM, delivery: { repos: { app: { mainCheckout: '/w/main', worktreeFolder: '../wt' } } } });
    const { files, ports } = leftover('/w/wt/t4', undefined);
    const result = await kit.run(['worktree', 'remove', '/w/wt/t4'], { worktrees: ports, env: { TEAMRIG_SESSION: 'bravo', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.equal(result.stdout.at(-1), `OK cleared the leftover ${resolve('/w/wt/t4')}`);
    assert.equal(await files.kindOf('/w/wt/t4'), 'missing');
  });

  it('refuses one in no folder worktrees are made in, as before', async () => {
    const { files, ports } = leftover('/w/elsewhere/t4', undefined);
    const result = await new CliHarness(null, null).run(['worktree', 'remove', '/w/elsewhere/t4'], { worktrees: ports });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, [`REFUSED ${resolve('/w/elsewhere/t4')} is not in a git worktree`]);
    assert.deepEqual(files.unlinked, []);
  });
});
