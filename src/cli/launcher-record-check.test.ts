import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KIT_VERSION } from '../core/version.ts';
import { LAUNCHER_RECORD_FORMAT, launcherRecordPath } from '../restore/launcher-refresh.ts';
import type { FoundPart, RegisteredPart } from '../restore/launcher-survey.ts';
import { CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const RECORD = launcherRecordPath(KIT);
const SOURCE = `from the restore launcher record ${RECORD}:`;
const NODE = join('/', 'node', 'node.exe');
const SCRIPT = join(KIT, 'bin', 'restore-logon.mjs');
const SHORTCUT = join(USER_HOME, 'Start Menu', 'teamrig restore.lnk');
const LOGON = 'the logon entry teamrig-restore';
const LOGON_PART: RegisteredPart = { kind: 'logon', where: LOGON, program: NODE, script: SCRIPT };
const SHORTCUT_PART: RegisteredPart = { kind: 'shortcut', where: SHORTCUT, program: NODE, script: SCRIPT };
const STRAY: FoundPart = { kind: 'shortcut', where: join(USER_HOME, 'Desktop', 'teamrig restore.lnk'), runs: 'cmd.exe /c start.bat' };

/** Writes a launcher record of `format` that lists `registered` and `found`, of this version, so no refresh is due. */
async function writeRecord(kit: CliHarness, registered: readonly RegisteredPart[], found: readonly FoundPart[], format: number = LAUNCHER_RECORD_FORMAT): Promise<void> {
  const record = { v: format, version: KIT_VERSION, at: '2030-01-08T09:00:00.000Z', registered, found };
  await kit.files.write(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

/** Makes each path there, as a file. */
async function makeThere(kit: CliHarness, ...paths: string[]): Promise<void> {
  for (const path of paths) {
    await kit.files.write(path, 'there');
  }
}

/** The lead's check rows from the restore launcher record. */
async function restoreRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' } });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the restore launcher record'));
}

function deadRow(where: string, gone: string): string {
  return `${SOURCE} RESTORE-DEAD ${where} starts ${gone}, which is gone: run teamrig restore install --yes, which writes the launchers and repoints it`;
}

describe('check RESTORE-DEAD and RESTORE-STRAY (T2030)', () => {
  it('flags a registered shortcut whose script is gone, naming the script', async () => {
    const kit = new CliHarness(TEAM);
    await writeRecord(kit, [SHORTCUT_PART], []);
    await makeThere(kit, NODE);
    assert.deepEqual(await restoreRows(kit), [deadRow(SHORTCUT, SCRIPT)]);
  });

  it('flags a registered logon entry left on a Node that is gone, naming the Node first', async () => {
    const kit = new CliHarness(TEAM);
    await writeRecord(kit, [LOGON_PART], []);
    assert.deepEqual(await restoreRows(kit), [deadRow(LOGON, NODE)]);
    await makeThere(kit, SCRIPT);
    assert.deepEqual(await restoreRows(kit), [deadRow(LOGON, NODE)]);
  });

  it('flags each found part that starts something else, with what it runs', async () => {
    const kit = new CliHarness(TEAM);
    await writeRecord(kit, [], [STRAY]);
    assert.deepEqual(await restoreRows(kit), [
      `${SOURCE} RESTORE-STRAY ${STRAY.where} runs ${STRAY.runs}, not what teamrig restore install set up: run teamrig restore install --yes to repoint it, ` +
        'or remove it and run teamrig restore install --yes (uninstall --yes where nothing should restore at logon) to update the record',
    ]);
  });

  it('flags nothing while every registered program and script is there', async () => {
    const kit = new CliHarness(TEAM);
    await writeRecord(kit, [LOGON_PART, SHORTCUT_PART], []);
    await makeThere(kit, NODE, SCRIPT);
    assert.deepEqual(await restoreRows(kit), []);
  });

  it('flags nothing for no record, a record of the older format, or one whose lists are damaged', async () => {
    assert.deepEqual(await restoreRows(new CliHarness(TEAM)), []);
    const older = new CliHarness(TEAM);
    await writeRecord(older, [LOGON_PART], [STRAY], LAUNCHER_RECORD_FORMAT - 1);
    assert.deepEqual(await restoreRows(older), []);
    const damaged = new CliHarness(TEAM);
    await damaged.files.write(RECORD, JSON.stringify({ v: LAUNCHER_RECORD_FORMAT, version: KIT_VERSION, at: '2030-01-08T09:00:00.000Z', registered: 'torn', found: [] }));
    assert.deepEqual(await restoreRows(damaged), []);
  });

  it("tells the lead once from any session's start, while the part stays dead", async () => {
    const kit = new CliHarness(TEAM);
    await writeRecord(kit, [LOGON_PART], []);
    for (let run = 0; run < 2; run += 1) {
      assert.equal((await kit.run(['start'], { env: { TEAMRIG_SESSION: 'alpha' } })).code, EXIT.ok);
    }
    const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
    const lines = inbox.split('\n').filter((line) => line.includes(`the restore launcher record ${RECORD} raised a warning no session owns`));
    assert.equal(lines.length, 1, inbox);
    assert.match(lines[0] ?? '', /so it is yours as lead: RESTORE-DEAD the logon entry teamrig-restore starts /);
  });
});
