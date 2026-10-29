import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MS_PER_DAY } from '../core/time.ts';
import { RETAIN_DAYS } from '../register/compaction.ts';
import { CliHarness, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';
import { FILES_LINE_MAX_NAMES } from './task-files.ts';

const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
const WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'front' } };

function add(title: string): string[] {
  return ['add', '--title', title, '--description', 'what and why', '--priority', 'p2'];
}

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = AS_ALPHA): Promise<CliResult> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
  return result;
}

describe("files <id>: a task's folder (T1457)", () => {
  it("prints the folder in the team's tasks folder alone, and makes it", async () => {
    const kit = new CliHarness();
    await ok(kit, add('Plan the layout'));
    const folder = join(TEAM_HOME, 'tasks', 'T1');
    assert.equal(kit.files.madeFolder(folder), false);
    assert.deepEqual((await ok(kit, ['files', 'T1'])).stdout, [folder]);
    assert.equal(kit.files.madeFolder(folder), true);
    assert.deepEqual((await ok(kit, ['files', 'T1'])).stdout, [folder]);
  });

  it('gives a task another team of the tree holds its folder in that team', async () => {
    const kit = await treeHarness();
    await ok(kit, ['add', '--title', 'Root task', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'], {});
    const folder = join(teamHomeOf('app'), 'tasks', 'T1');
    assert.deepEqual((await ok(kit, ['files', 'T1'], WEB)).stdout, [folder]);
    assert.equal(kit.files.madeFolder(folder), true);
  });

  it('finds a task a compaction retired from the working set', async () => {
    const kit = new CliHarness();
    await ok(kit, add('Old plan'));
    await ok(kit, ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none']);
    await ok(kit, add('Current plan'));
    await ok(kit, ['compact']);
    kit.clock.advance((RETAIN_DAYS + 1) * MS_PER_DAY);
    await ok(kit, ['compact']);
    assert.deepEqual((await ok(kit, ['files', 'T1'])).stdout, [join(TEAM_HOME, 'tasks', 'T1')]);
  });

  it('refuses an id no register holds, and makes no folder', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['files', 'T9'], AS_ALPHA);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED no task T9']]);
    assert.deepEqual(await kit.files.list(join(TEAM_HOME, 'tasks')), []);
  });

  it('refuses a word that is not a task id, and a call naming neither a task nor --notes', async () => {
    const kit = new CliHarness();
    const typo = await kit.run(['files', 'design'], AS_ALPHA);
    assert.equal(typo.code, EXIT.usage);
    assert.match(typo.stderr[0] ?? '', /^"design" is not a task id like T12\n/);
    const bare = await kit.run(['files'], AS_ALPHA);
    assert.equal(bare.code, EXIT.usage);
    assert.match(bare.stderr[0] ?? '', /files needs <id>, or --notes for your notes/);
  });
});

describe("files --notes: a session's notes that belong to no task (T1457)", () => {
  it("prints the caller's notes folder and makes it", async () => {
    const kit = new CliHarness();
    const folder = join(TEAM_HOME, 'notes', 'alpha');
    assert.deepEqual((await ok(kit, ['files', '--notes'])).stdout, [folder]);
    assert.equal(kit.files.madeFolder(folder), true);
    assert.deepEqual((await ok(kit, ['files', '--notes', '--session', 'bravo'])).stdout, [join(TEAM_HOME, 'notes', 'bravo')]);
  });

  it('refuses a session not on the team, and a task id beside --notes', async () => {
    const kit = new CliHarness();
    const stranger = await kit.run(['files', '--notes', '--session', 'zulu']);
    assert.equal(stranger.code, EXIT.refused);
    assert.deepEqual(await kit.files.list(join(TEAM_HOME, 'notes')), []);
    const both = await kit.run(['files', 'T1', '--notes'], AS_ALPHA);
    assert.equal(both.code, EXIT.usage);
    assert.match(both.stderr[0] ?? '', /unexpected "T1"/);
  });
});

describe("show: a task's files line (T1457)", () => {
  const filesLine = (shown: CliResult) => shown.stdout.join('\n').split('\n').find((line) => line.startsWith('files in '));

  it('names the folder and none yet while nothing is in it, and makes no folder', async () => {
    const kit = new CliHarness();
    await ok(kit, add('Plan the layout'));
    const folder = join(TEAM_HOME, 'tasks', 'T1');
    assert.equal(filesLine(await ok(kit, ['show', 'T1'])), `files in ${folder}: none yet`);
    assert.equal(kit.files.madeFolder(folder), false);
  });

  it('lists what the folder holds in name order, a folder with a slash, above the history', async () => {
    const kit = new CliHarness();
    await ok(kit, add('Plan the layout'));
    const folder = join(TEAM_HOME, 'tasks', 'T1');
    await kit.files.write(join(folder, 'design.md'), '# design');
    await kit.files.write(join(folder, 'build.md'), '# build');
    await kit.files.write(join(folder, 'evidence', 'run.log'), 'ok');
    const shown = await ok(kit, ['show', 'T1'], { ...AS_ALPHA, probe: new MemoryPathProbe(kit.files) });
    const lines = shown.stdout.join('\n').split('\n');
    const at = lines.indexOf(`files in ${folder}: build.md, design.md, evidence/`);
    assert.ok(at > 0, lines.join('\n'));
    assert.equal(lines[at + 1], 'history:');
  });

  it(`names the first ${FILES_LINE_MAX_NAMES} and counts the rest`, async () => {
    const kit = new CliHarness();
    await ok(kit, add('Plan the layout'));
    const folder = join(TEAM_HOME, 'tasks', 'T1');
    const names = Array.from({ length: FILES_LINE_MAX_NAMES + 2 }, (_, at) => `n${String(at).padStart(2, '0')}.md`);
    await Promise.all(names.map((name) => kit.files.write(join(folder, name), 'x')));
    const line = filesLine(await ok(kit, ['show', 'T1'])) ?? '';
    assert.ok(line.endsWith(`${names[FILES_LINE_MAX_NAMES - 1]}, and 2 more`), line);
    assert.ok(!line.includes(names[FILES_LINE_MAX_NAMES] ?? ''), line);
  });
});
