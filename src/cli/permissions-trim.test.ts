import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { PointerGit, PointerInGit } from '../setup/pointer-ignore.ts';
import { CliHarness, APP, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { NO_PATHS_HOST } from '../testing/host.ts';
import { EXIT } from './runtime.ts';

/** A value a rule can hold; no output may carry it. Joined, so no source line holds a URL the secret redactor catches. */
const HELD_VALUE = ['postgres://user:', 'hunter22', '@db.example.net'].join('');
const STATE = join('/', 'state');
const BACKUPS = join(STATE, 'teamrig', 'permissions-backups', '20300108T100000Z');
const USER = join(USER_HOME, '.claude', 'settings.json');
const SHARED = join(APP, '.claude', 'settings.json');
const LOCAL = join(APP, '.claude', 'settings.local.json');
const TREE = join(APP, '.claude', 'worktrees', 'fix', '.claude', 'settings.local.json');
const OPTIONS: RunOptions = { platform: 'linux', env: { XDG_STATE_HOME: STATE } };

/** A team whose user settings, project and Claude Code worktree each hold a wide rule, beside rules a trim keeps. */
async function withSettings(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.files.write(USER, formatConfig({ model: 'opus', permissions: { allow: ['Bash', 'Bash(kubectl get:*)', `Bash(psql ${HELD_VALUE})`], deny: ['Read(.env)'] } }));
  await kit.files.write(SHARED, formatConfig({ permissions: { allow: ['Bash(git push:*)'] } }));
  await kit.files.write(LOCAL, formatConfig({ permissions: { allow: ['Read(//c/**)', 'WebSearch'] } }));
  await kit.files.write(TREE, formatConfig({ permissions: { allow: ['Bash(node:*)', 'Bash(git log)'] } }));
  return kit;
}

/** git's word on the project's settings.json, and no repository for any other path. */
function sharedIs(state: PointerInGit): PointerGit {
  return { state: (path) => (path === SHARED ? state : { kind: 'no-git' }) };
}

function allowOf(kit: CliHarness, path: string): unknown {
  const text = kit.files.get(path);
  return text === undefined ? undefined : JSON.parse(text);
}

function assertNoSecret(lines: readonly string[]): void {
  assert.ok(lines.every((line) => !line.includes('hunter22')));
}

describe('teamrig permissions trim', () => {
  it("refuses on a host whose folders teamrig does not know, with the host's own reason, and writes nothing", async () => {
    const kit = await withSettings();
    const before = kit.files.get(USER);
    const result = await kit.run(['permissions', 'trim', '--yes'], { ...OPTIONS, host: NO_PATHS_HOST });
    assert.equal(result.code, EXIT.refused);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /REFUSED no folder of the host is known/);
    assert.equal(kit.files.get(USER), before);
  });

  it('previews the wide and credential rules off the keep-list in each file by class, and writes nothing without --yes', async () => {
    const kit = await withSettings();
    const before = [USER, SHARED, LOCAL, TREE].map((path) => kit.files.get(path));
    const result = await kit.run(['permissions', 'trim'], OPTIONS);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      'PREVIEW nothing written (add --yes to write): removes the allow rules that approve a whole tool or program or hold a credential off permissions.keepAllow',
      `  ${USER}: 3 allow rules -> 1, remove 2 (Bash credential 1, Bash wide 1); keeps 1 on the keep-list`,
      `  ${SHARED}: 1 allow rules, 1 to remove (Bash wide 1); it is committed with its repo, so change it by a commit`,
      `  ${LOCAL}: 2 allow rules -> 1, remove 1 (Read wide 1); keeps 1 on the keep-list`,
      `  ${TREE}: 2 allow rules -> 1, remove 1 (Bash wide 1); keeps 0 on the keep-list, 1 more (Bash exact 1)`,
      'TOTAL 3 file(s) to rewrite: 7 allow rules -> 3 (remove 4: Bash wide 2, Bash credential 1, Read wide 1)',
    ]);
    assertNoSecret(result.stdout);
    assert.deepEqual(
      [USER, SHARED, LOCAL, TREE].map((path) => kit.files.get(path)),
      before,
    );
  });

  it('with --yes keeps each old file and a manifest first, rewrites only permissions.allow, and then finds nothing to remove', async () => {
    const kit = await withSettings();
    const shared = kit.files.get(SHARED);
    const result = await kit.run(['permissions', 'trim', '--yes'], OPTIONS);
    assert.deepEqual([result.code, result.stdout], [
      EXIT.ok,
      [
        `WROTE 3 of 3 file(s); their old text and a manifest are in ${BACKUPS}`,
        `  ${USER}: 3 allow rules -> 1, removed Bash credential 1, Bash wide 1`,
        `  ${LOCAL}: 2 allow rules -> 1, removed Read wide 1`,
        `  ${TREE}: 2 allow rules -> 1, removed Bash wide 1`,
      ],
    ]);
    assertNoSecret(result.stdout);
    assert.deepEqual(allowOf(kit, USER), { model: 'opus', permissions: { allow: ['Bash(kubectl get:*)'], deny: ['Read(.env)'] } });
    assert.deepEqual(allowOf(kit, TREE), { permissions: { allow: ['Bash(git log)'] } });
    assert.equal(kit.files.get(SHARED), shared);
    assert.deepEqual((await kit.files.list(BACKUPS)).sort(), ['01-settings.json', '02-settings.local.json', '03-settings.local.json', 'manifest.json']);
    const again = await kit.run(['permissions', 'trim', '--yes'], OPTIONS);
    assert.deepEqual([again.code, again.stdout[0]], [EXIT.ok, 'UNCHANGED no settings file to rewrite holds the allow rules that approve a whole tool or program or hold a credential off permissions.keepAllow']);
  });

  it('reports a settings.json its repository tracks, and rewrites one it ignores or never added, with its backup (#837)', async () => {
    const committed = '  ' + SHARED + ': 1 allow rules, 1 to remove (Bash wide 1); it is committed with its repo, so change it by a commit';
    const tracked = await (await withSettings()).run(['permissions', 'trim'], { ...OPTIONS, pointerGit: sharedIs({ kind: 'tracked' }) });
    assert.equal(tracked.stdout[2], committed);

    // git could not tell (no repository, or no answer): the file stays committed, and --yes leaves it as it was.
    const unknown = await withSettings();
    const before = unknown.files.get(SHARED);
    const noGit = { ...OPTIONS, pointerGit: sharedIs({ kind: 'no-git' }) };
    assert.equal((await unknown.run(['permissions', 'trim'], noGit)).stdout[2], committed);
    const kept = await unknown.run(['permissions', 'trim', '--yes'], noGit);
    assert.deepEqual([kept.code, kept.stdout.includes(`  ${SHARED}: 1 allow rules -> 0, removed Bash wide 1`)], [EXIT.ok, false]);
    assert.equal(unknown.files.get(SHARED), before);

    for (const state of [{ kind: 'ignored' }, { kind: 'open', exclude: join(APP, '.git', 'info', 'exclude') }] satisfies PointerInGit[]) {
      const kit = await withSettings();
      const options = { ...OPTIONS, pointerGit: sharedIs(state) };
      const preview = await kit.run(['permissions', 'trim'], options);
      assert.deepEqual([preview.stdout[2], preview.stdout.at(-1)], [
        `  ${SHARED}: 1 allow rules -> 0, remove 1 (Bash wide 1); keeps 0 on the keep-list`,
        'TOTAL 4 file(s) to rewrite: 8 allow rules -> 3 (remove 5: Bash wide 3, Bash credential 1, Read wide 1)',
      ], state.kind);
      const shared = kit.files.get(SHARED);
      const written = await kit.run(['permissions', 'trim', '--yes'], options);
      assert.deepEqual([written.code, written.stdout[0], written.stdout[2]], [EXIT.ok, `WROTE 4 of 4 file(s); their old text and a manifest are in ${BACKUPS}`, `  ${SHARED}: 1 allow rules -> 0, removed Bash wide 1`], state.kind);
      assert.deepEqual(allowOf(kit, SHARED), { permissions: { allow: [] } });
      assert.equal(kit.files.get(join(BACKUPS, '02-settings.json')), shared);
    }
  });

  it('with --all removes the exact rules off the keep-list too', async () => {
    const kit = await withSettings();
    const result = await kit.run(['permissions', 'trim', '--all'], OPTIONS);
    assert.equal(result.stdout[0], 'PREVIEW nothing written (add --yes to write): removes every allow rule off permissions.keepAllow');
    assert.equal(result.stdout.at(-1), 'TOTAL 3 file(s) to rewrite: 7 allow rules -> 2 (remove 5: Bash wide 2, Bash credential 1, Bash exact 1, Read wide 1)');
    assertNoSecret(result.stdout);
  });

  it("removes an exact rule that holds one of the team's own secret shapes", async () => {
    const kit = new CliHarness({ sessions: ['lead'], roles: { lead: 'lead' }, register: { secretPatterns: ['hush-[0-9]+'] } });
    await kit.files.write(LOCAL, formatConfig({ permissions: { allow: ['Bash(deploy --token hush-42)', 'Bash(git log)'] } }));
    const result = await kit.run(['permissions', 'trim'], OPTIONS);
    assert.deepEqual(result.stdout.slice(1), [
      `  ${LOCAL}: 2 allow rules -> 1, remove 1 (Bash credential 1); keeps 0 on the keep-list, 1 more (Bash exact 1)`,
      'TOTAL 1 file(s) to rewrite: 2 allow rules -> 1 (remove 1: Bash credential 1)',
    ]);
    assert.ok(result.stdout.every((line) => !line.includes('hush-42')));
  });

  it("checks the settings of each repository teamrig merges into, and keeps the team's own keep-list", async () => {
    const repo = join('/', 'work', 'api');
    const kit = new CliHarness({ sessions: ['lead'], roles: { lead: 'lead' }, delivery: { repos: { api: { mainCheckout: repo } } }, permissions: { keepAllow: ['Bash'] } });
    await kit.files.write(join(repo, '.claude', 'settings.local.json'), formatConfig({ permissions: { allow: ['Bash', 'Edit'] } }));
    const result = await kit.run(['permissions', 'trim'], OPTIONS);
    assert.deepEqual(result.stdout.slice(1), [
      `  ${join(repo, '.claude', 'settings.local.json')}: 2 allow rules -> 1, remove 1 (Edit wide 1); keeps 1 on the keep-list`,
      'TOTAL 1 file(s) to rewrite: 2 allow rules -> 1 (remove 1: Edit wide 1)',
    ]);
  });
});
