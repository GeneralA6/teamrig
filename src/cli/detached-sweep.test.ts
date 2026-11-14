import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatRunRecord, runRecordPathOf, type DetachedRunRecord } from '../delivery/detached-runs.ts';
import { CliHarness, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const DIR = join(TEAM_HOME, 'state', 'deploys', 'detached');
const ID = '20300108-093000-5150';
const LOG = join(DIR, `${ID}.log`);
const RECORD = runRecordPathOf(DIR, ID);
const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
/** A run of alpha's that began to wait at 09:30 UTC, its process 5150 not in the harness's process table. */
const DEAD: DetachedRunRecord = { v: 1, id: ID, team: 'app', session: 'alpha', what: 'build api', log: LOG, pid: 5150, startedAt: '2030-01-08T09:30:00.000Z' };
const DIED = `queue ${ID} died while it waited for its turn: build api: its process (pid 5150) ended with no end of its own, so nothing else reports it; re-run it; log ${LOG}`;

/** Files where the run's record is listed and read, then gone by the time a sweep removes it, as when another took it. */
class TakenFirst extends FaultyFiles {
  override async remove(path: string): Promise<boolean> {
    const removed = await super.remove(path);
    return path === RECORD ? false : removed;
  }
}

async function alphaWakes(kit: CliHarness): Promise<string[]> {
  return (await new WakeAsks(kit.files, join(TEAM_HOME, 'state', 'wake-asks')).read('alpha')).flatMap(({ ask }) => (ask === undefined ? [] : [`${ask.from}: ${ask.text}`]));
}

async function withRun(record: DetachedRunRecord, path: string = RECORD): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.files.write(LOG, '2030-01-08 09:30:00 UTC waiting for the host lock\n');
  await kit.files.write(path, formatRunRecord(record));
  return kit;
}

describe('the sweep of detached queue runs that died (T2742)', () => {
  it("tells a session's start of its run whose process ended with no end: a DIED line in the log and a wake, once", async () => {
    const kit = await withRun(DEAD);
    const started = await kit.run(['start'], AS_ALPHA);
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    assert.ok(started.stdout.some((line) => line.endsWith(`alpha: ${DIED}`)), 'in the inbox lines of the start that found it');
    assert.equal(kit.files.get(LOG), `2030-01-08 09:30:00 UTC waiting for the host lock\n2030-01-08 10:00:00 UTC DIED ${DIED}\n`);
    assert.deepEqual([kit.files.get(RECORD), await alphaWakes(kit)], [undefined, [`alpha: ${DIED}`]]);

    assert.equal((await kit.run(['start'], { env: { TEAMRIG_SESSION: 'bravo' } })).code, EXIT.ok);
    assert.deepEqual(await alphaWakes(kit), [`alpha: ${DIED}`], 'told once, whichever session starts next');
  });

  it("says the stage of a run that died while its step ran, and tells any session's start, not only its own", async () => {
    const kit = await withRun({ ...DEAD, runningAt: '2030-01-08T09:40:00.000Z' });
    assert.equal((await kit.run(['start'], { env: { TEAMRIG_SESSION: 'bravo' } })).code, EXIT.ok);
    assert.deepEqual(await alphaWakes(kit), [`alpha: ${DIED.replace('while it waited for its turn', 'while its step ran')}`]);
  });

  it("leaves a live run and another team's run alone", async () => {
    const kit = await withRun(DEAD);
    kit.sessionProcesses.add({ pid: 5150, parentPid: 1, name: 'node.exe', commandLine: 'node teamrig queue --detached-run' });
    const otherTeam = runRecordPathOf(DIR, 'web-run');
    await kit.files.write(otherTeam, formatRunRecord({ ...DEAD, id: 'web-run', team: 'web', pid: 6160 }));
    assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    assert.deepEqual([kit.files.get(RECORD) !== undefined, kit.files.get(otherTeam) !== undefined, await alphaWakes(kit)], [true, true, []]);
  });

  it('warns of a folder it cannot read, and the start goes on', async () => {
    const kit = await withRun(DEAD);
    const files = new FaultyFiles(kit.files).fail('list', DIR, systemError('EACCES', 'EACCES: permission denied'));
    const started = await kit.run(['start'], { ...AS_ALPHA, files });
    assert.equal(started.code, EXIT.ok);
    assert.equal(started.stderr[0], 'WARN the detached runs were not read: EACCES: permission denied');
    assert.match(started.stdout.at(-1) ?? '', /^Week: /);
  });

  it('tells nothing of a run whose record another sweep or the run itself took first', async () => {
    const kit = await withRun(DEAD);
    assert.equal((await kit.run(['start'], { ...AS_ALPHA, files: new TakenFirst(kit.files) })).code, EXIT.ok);
    assert.deepEqual([kit.files.get(LOG)?.includes('DIED'), await alphaWakes(kit)], [false, []]);
  });
});
