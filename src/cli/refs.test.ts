import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const OLD = 'notes/ops/board.md';
const NEW = 'notes/ops/archive/board.md';
const FILE = join(APP, 'refs.json');

const TASKS: ReadonlyArray<readonly [string, string]> = [['Ship the docs', OLD], ['Ship the CLI', NEW], ['Ship the pane', 'notes/ops/pane.md']];

/** Tasks T1 (ref OLD), T2 (ref NEW) and T3 (another ref), all owned by alpha. */
async function threeTasks(kit: CliHarness): Promise<void> {
  for (const [title, ref] of TASKS) {
    const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--ref', ref, '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
  }
}

async function refOf(kit: CliHarness, id: string): Promise<string | undefined> {
  const shown = await kit.run(['show', id]);
  const line = shown.stdout.flatMap((text) => text.split('\n')).find((text) => text.trimStart().startsWith('ref: '));
  return line?.trimStart().slice('ref: '.length);
}

function rows(...ids: ReadonlyArray<readonly [string, string]>): string {
  return JSON.stringify(ids.map(([team, id]) => ({ team, id, oldRef: OLD, newRef: NEW })));
}

describe('runCli: refs apply', () => {
  it("previews each row's fate, writes nothing, then writes with --yes and reads as already-new after", async () => {
    const kit = new CliHarness();
    await threeTasks(kit);
    await kit.files.write(FILE, rows(['app', 'T1'], ['app', 'T2'], ['app', 'T3'], ['ops', 'T4'], ['app', 'T9']));
    const left = [
      `LEFT T2 (already-new): its ref reads ${NEW}`,
      `LEFT T3 (changed-since): its ref reads notes/ops/pane.md, not ${OLD}`,
      'LEFT ops/T4 (other-team): a session of team ops applies it',
      'LEFT T9 (not-found): no task T9 in the working set',
    ];

    const dry = await kit.run(['refs', 'apply', 'refs.json', '--session', 'alpha']);
    assert.deepEqual([dry.code, dry.stdout], [EXIT.ok, [`WOULD UPDATE T1: ${OLD} -> ${NEW}`, ...left, 'dry run: would update 1, left 4; nothing was written: rerun with --yes to write']]);
    assert.equal(await refOf(kit, 'T1'), OLD);

    const applied = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'alpha']);
    assert.deepEqual([applied.code, applied.stdout], [EXIT.ok, [`UPDATED T1: ${OLD} -> ${NEW}`, ...left, 'updated 1, left 4']]);
    assert.equal(await refOf(kit, 'T1'), NEW);

    const again = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'alpha']);
    assert.deepEqual([again.code, again.stdout[0], again.stdout.at(-1)], [EXIT.ok, `LEFT T1 (already-new): its ref reads ${NEW}`, 'updated 0, left 5']);
  });

  it("leaves a row the policy refuses the caller, in the dry run and the write, and exits refused after --yes", async () => {
    const kit = new CliHarness();
    await threeTasks(kit);
    await kit.files.write(FILE, rows(['app', 'T1']));

    const dry = await kit.run(['refs', 'apply', FILE, '--session', 'bravo']);
    assert.equal(dry.code, EXIT.ok);
    assert.match(dry.stdout[0] ?? '', /^LEFT T1 \(refused\): /);

    const refused = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'bravo']);
    assert.deepEqual([refused.code, refused.stdout[0], refused.stdout.at(-1)], [EXIT.refused, dry.stdout[0], 'updated 0, left 1, 1 of them refused']);
    assert.equal(await refOf(kit, 'T1'), OLD);
  });

  it('refuses a missing file, one that is not JSON and one that holds no list of rows, writing nothing', async () => {
    const kit = new CliHarness();
    await threeTasks(kit);
    const missing = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'alpha']);
    assert.deepEqual([missing.code, missing.stdout], [EXIT.refused, [`REFUSED no ref-change file ${FILE}`]]);

    await kit.files.write(FILE, '[{');
    const broken = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'alpha']);
    assert.equal(broken.code, EXIT.refused);
    assert.match(broken.stdout[0] ?? '', /^REFUSED .*refs\.json is not JSON: /);

    await kit.files.write(FILE, JSON.stringify([{ team: 'app', id: 'T1', oldRef: OLD, newRef: NEW }, { team: 'app', id: 'T1', oldRef: OLD, newRef: 'notes/b.md' }]));
    const repeated = await kit.run(['refs', 'apply', FILE, '--yes', '--session', 'alpha']);
    assert.deepEqual([repeated.code, repeated.stdout], [EXIT.refused, [`REFUSED ${FILE}: row 2 repeats app/T1: give each task one row`]]);
    assert.equal(await refOf(kit, 'T1'), OLD);
  });

  it('wants the file and a caller', async () => {
    const kit = new CliHarness();
    const bare = await kit.run(['refs', 'apply', '--session', 'alpha']);
    assert.equal(bare.code, EXIT.usage);
    await kit.files.write(FILE, rows(['app', 'T1']));
    const unknown = await kit.run(['refs', 'apply', FILE, '--session', 'zulu']);
    assert.equal(unknown.code, EXIT.refused);
  });
});
