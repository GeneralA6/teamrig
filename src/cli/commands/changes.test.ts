import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, TEAM, type CliResult } from '../../testing/cli-harness.ts';
import { commitOf, FakeChangeGit } from '../../testing/fake-change-git.ts';
import { EXIT } from '../runtime.ts';

const RELEASES = [
  { version: '0.2.0', at: '2030-01-07T12:00:00.000Z', sha: 'r0200000000' },
  { version: '0.1.0', at: '2030-01-06T12:00:00.000Z', sha: 'r0100000000' },
];

const HISTORY = [
  commitOf('n1000000000', '2030-01-08T09:00:00.000Z', 'feat(cli): a flag not released yet'),
  commitOf('r0200000000', '2030-01-07T12:00:00.000Z', 'plugin: version 0.2.0, x'),
  commitOf('b2000000000', '2030-01-07T11:00:00.000Z', 'fix(open): a console tab (T1)', ['src/open/tab.ts']),
  commitOf('a2000000000', '2030-01-07T10:00:00.000Z', 'feat(ship)!: ship needs --approved', ['tools/ship/ship.ts']),
  commitOf('r0100000000', '2030-01-06T12:00:00.000Z', 'plugin: version 0.1.0, x'),
];

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

async function project(team = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(team);
  await kit.files.write(join(APP, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  ok(await kit.run(['add', '--title', 'teamrig open works with no Windows Terminal', '--description', 'what and why', '--priority', 'p1', '--type', 'bug', '--session', 'lead']));
  return kit;
}

const git = () => ({ changeGit: new FakeChangeGit(HISTORY, RELEASES) });

describe('teamrig changes', () => {
  it("lists what changed since a version, newest release first, a task's commits as its one entry", async () => {
    const kit = await project();
    const result = await kit.run(['changes', '--since', '0.1.0'], git());
    ok(result);
    assert.deepEqual(result.stdout, [
      'CHANGES since 0.1.0: 3 change(s) from register, git',
      'NOT RELEASED YET',
      '  feature cli: a flag not released yet (n10000000)',
      '0.2.0 (2030-01-07)',
      '  behaviour ship: ship needs --approved (a20000000)',
      '  fix open: teamrig open works with no Windows Terminal (T1 b20000000)',
    ]);
  });

  it("reads a day on the team's clock, and narrows to a file and an area", async () => {
    const kit = await project();
    const byDay = await kit.run(['changes', '--since', '2030-01-08'], git());
    ok(byDay);
    assert.deepEqual(byDay.stdout.slice(1), ['NOT RELEASED YET', '  feature cli: a flag not released yet (n10000000)']);
    const byFile = await kit.run(['changes', '--since', '0.1.0', '--file', 'tools/ship'], git());
    assert.deepEqual(byFile.stdout.slice(1), ['0.2.0 (2030-01-07)', '  behaviour ship: ship needs --approved (a20000000)']);
    const byArea = await kit.run(['changes', '--since', '0.1.0', '--until', '0.2.0', '--area', 'open'], git());
    assert.deepEqual(byArea.stdout, ['CHANGES since 0.1.0 up to 0.2.0: 1 change(s) from register, git', '0.2.0 (2030-01-07)', '  fix open: teamrig open works with no Windows Terminal (T1 b20000000)']);
  });

  it('shows an action note with its step, and a bad note as a warning', async () => {
    const kit = await project({ ...TEAM, changes: { sources: ['notes'] } });
    await kit.files.write(join(APP, 'changes', 'a.md'), '---\narea: setup\nkind: action\naction: teamrig setup\n---\nRun setup again after this install.\n');
    await kit.files.write(join(APP, 'changes', 'b.md'), 'no front matter');
    const result = await kit.run(['changes', '--since', '0.2.0'], git());
    ok(result);
    assert.deepEqual(result.stdout, [
      'CHANGES since 0.2.0: 1 change(s) from notes',
      'NOT RELEASED YET',
      '  ACTION setup: Run setup again after this install.',
      '    do: teamrig setup',
      'WARN notes: changes/b.md:1 has no front matter: start it with --- lines naming its area and kind',
    ]);
  });

  it('refuses a version the project never released, naming the ones it did', async () => {
    const kit = await project();
    const result = await kit.run(['changes', '--since', '0.9.0'], git());
    assert.equal(result.code, EXIT.refused);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /no release 0\.9\.0; its newest: 0\.2\.0, 0\.1\.0/);
  });

  it('refuses a --since that is neither a version nor a time, and needs one', async () => {
    const kit = await project();
    const bad = await kit.run(['changes', '--since', 'last week'], git());
    assert.equal(bad.code, EXIT.usage);
    assert.match(bad.stderr.join('\n'), /--since takes a version/);
    assert.equal((await kit.run(['changes'], git())).code, EXIT.usage);
  });

  it('names a source that failed beside the rest', async () => {
    const kit = await project();
    const changeGit = new FakeChangeGit(HISTORY, RELEASES);
    changeGit.failure = 'fatal: not a git repository';
    const result = await kit.run(['changes', '--since', '2030-01-01'], { changeGit });
    ok(result);
    assert.deepEqual(result.stdout, ['CHANGES since 01-01 00:00 UTC: 0 change(s) from register, git', 'FAILED register: fatal: not a git repository', 'FAILED git: fatal: not a git repository']);
  });
});
