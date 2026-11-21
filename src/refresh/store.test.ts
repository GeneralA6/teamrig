import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { ParkedRestart, RestartRequest } from './state.ts';
import { RefreshStore } from './store.ts';

const PATHS = { refresh: join('/', 'team', 'state', 'refresh'), handover: join('/', 'team', 'handover') };
const AT = '2030-01-08T10:00:00.000Z';

describe('RefreshStore', () => {
  it("keeps each session's state, and has none before the first write", async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    assert.equal(await store.state('alpha'), undefined);
    await store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT, finished: 1, ask: null });
    assert.deepEqual(await store.state('alpha'), { phase: 'boundary', task: 'T3', at: AT, finished: 1, ask: null });
    assert.equal(await store.state('bravo'), undefined);
    assert.equal(files.paths().length, 1);
    assert.match(files.get(join(PATHS.refresh, 'alpha.json')) ?? '', /"phase":"boundary"/);
  });

  it('refuses to overwrite a state file a newer teamrig wrote', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const path = join(PATHS.refresh, 'alpha.json');
    await files.write(path, '{"v":4,"phase":"boundary","task":"T3","at":"x","finished":1,"ask":null,"later":true}\n');
    await assert.rejects(store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT, finished: 2, ask: null }), NewerDataError);
    assert.match(files.get(path) ?? '', /"later":true/);
    await files.write(path, '{"v":1,"phase":"boundary","task":"T3","at":"x","finished":1,"ask":null}\n');
    await store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT, finished: 2, ask: null });
    assert.match(files.get(path) ?? '', /^\{"v":3,/);
  });

  it("keeps the lead's request in a file of its own, so neither write overwrites the other", async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    await store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT, finished: 1, ask: null });
    assert.equal(await store.request('alpha'), undefined);
    await store.setRequest('alpha', { by: 'lead', at: AT });
    assert.deepEqual(await store.request('alpha'), { by: 'lead', at: AT });
    assert.deepEqual(await store.state('alpha'), { phase: 'boundary', task: 'T3', at: AT, finished: 1, ask: null });
    await store.clearRequest('alpha');
    await store.clearRequest('alpha');
    assert.equal(await store.request('alpha'), undefined);
  });

  it('keeps the automatic restart in a file of its own, and reads a damaged one as none', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const restart: RestartRequest = { phase: 'pending', at: AT, pid: 4242, claudeSession: 'c-1', transcript: '/t/c-1.jsonl', cwd: null, supervised: false, effort: null };
    await files.write(join(PATHS.refresh, 'alpha.restart.json'), JSON.stringify({ v: 1, ...restart }));
    assert.deepEqual(await store.restart('alpha'), restart, 'the hand-written good file reads, so the damaged ones below fail for their field');
    await store.clearRestart('alpha');
    assert.equal(await store.restart('alpha'), undefined);
    await store.setRestart('alpha', restart);
    assert.deepEqual(await store.restart('alpha'), restart);
    await store.setRestart('alpha', { ...restart, phase: 'ending', supervised: true });
    assert.deepEqual(await store.restart('alpha'), { ...restart, phase: 'ending', supervised: true });
    await store.setRestart('alpha', { ...restart, effort: 'xhigh' });
    assert.deepEqual(await store.restart('alpha'), { ...restart, effort: 'xhigh' }, 'the level the turn ran at (T2444)');
    // JSON leaves an undefined field out, as a file written before the level has it.
    await files.write(join(PATHS.refresh, 'alpha.restart.json'), JSON.stringify({ v: 1, ...restart, effort: undefined }));
    assert.deepEqual(await store.restart('alpha'), restart, 'a file from before the level reads as none');
    assert.equal(await store.state('alpha'), undefined, 'the state is another file');
    for (const bad of [{ phase: 'later' }, { pid: 0 }, { pid: 'x' }, { transcript: 3 }, { supervised: 'no' }, { effort: 'turbo' }, { effort: 3 }]) {
      await files.write(join(PATHS.refresh, 'alpha.restart.json'), JSON.stringify({ v: 1, ...restart, ...bad }));
      assert.equal(await store.restart('alpha'), undefined, JSON.stringify(bad));
    }
    await store.clearRestart('alpha');
    await store.clearRestart('alpha');
    assert.equal(await store.restart('alpha'), undefined);
  });

  it('keeps the restart held back until work comes in a file of its own, and reads a damaged one as none (T1383)', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const parked: ParkedRestart = { at: AT, claudeSession: 'c-1', transcript: '/t/c-1.jsonl', cwd: null, supervised: false, effort: null };
    assert.equal(await store.parked('alpha'), undefined);
    await store.setParked('alpha', parked);
    assert.deepEqual(await store.parked('alpha'), parked);
    assert.deepEqual([files.paths().length, await store.restart('alpha')], [1, undefined], 'the pending restart is another file');
    assert.match(files.get(join(PATHS.refresh, 'alpha.parked.json')) ?? '', /"claudeSession":"c-1"/);
    for (const bad of [{ at: 3 }, { claudeSession: null }, { transcript: 3 }, { cwd: false }, { supervised: 'no' }, { v: 3 }, { v: 0 }]) {
      await files.write(join(PATHS.refresh, 'alpha.parked.json'), JSON.stringify({ v: 1, ...parked, ...bad }));
      assert.equal(await store.parked('alpha'), undefined, JSON.stringify(bad));
    }
    await store.clearParked('alpha');
    await store.clearParked('alpha');
    assert.equal(await store.parked('alpha'), undefined);
  });

  it('writes the restart files as the very lines every installed teamrig reads (T4762)', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const tab = { claudeSession: 'c-1', transcript: '/t/c-1.jsonl', cwd: null, supervised: false, effort: null };
    await store.setRestart('alpha', { phase: 'pending', at: AT, pid: 4242, ...tab });
    await store.setParked('alpha', { at: AT, ...tab });
    // Each record's own keys are spread into its line, so a renamed property renames the key on disk: these lines
    // may change only in the commit that raises the written format.
    const tabText = '"claudeSession":"c-1","transcript":"/t/c-1.jsonl","cwd":null,"supervised":false,"effort":null';
    assert.equal(files.get(join(PATHS.refresh, 'alpha.restart.json')), `{"v":1,"phase":"pending","at":"${AT}","pid":4242,${tabText}}\n`);
    assert.equal(files.get(join(PATHS.refresh, 'alpha.parked.json')), `{"v":1,"at":"${AT}",${tabText}}\n`);
  });

  it('reads the restart files a later teamrig wrote, naming the tab hostSession, and one newer still as none (T4762)', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const tab = { transcript: '/t/c-1.jsonl', cwd: null, supervised: false, effort: null };
    const restart: RestartRequest = { phase: 'pending', at: AT, pid: 4242, claudeSession: 'c-1', ...tab };
    const parked: ParkedRestart = { at: AT, claudeSession: 'c-1', ...tab };
    const restartPath = join(PATHS.refresh, 'alpha.restart.json');
    const parkedPath = join(PATHS.refresh, 'alpha.parked.json');
    await files.write(restartPath, `${JSON.stringify({ v: 2, phase: 'pending', at: AT, pid: 4242, hostSession: 'c-1', ...tab })}\n`);
    await files.write(parkedPath, `${JSON.stringify({ v: 2, at: AT, hostSession: 'c-1', ...tab })}\n`);
    assert.deepEqual([await store.restart('alpha'), await store.parked('alpha')], [restart, parked]);
    await files.write(restartPath, JSON.stringify({ v: 3, phase: 'pending', at: AT, pid: 4242, hostSession: 'c-1', ...tab }));
    await files.write(parkedPath, JSON.stringify({ v: 3, at: AT, hostSession: 'c-1', ...tab }));
    assert.deepEqual([await store.restart('alpha'), await store.parked('alpha')], [undefined, undefined]);
    // The lead's request names no tab, so its format does not move.
    await files.write(join(PATHS.refresh, 'alpha.request.json'), JSON.stringify({ v: 2, by: 'lead', at: AT }));
    assert.equal(await store.request('alpha'), undefined);
  });

  it('keeps what cancelled a pending restart in a file of its own, spent as it is read, and reads a damaged one as none (#706)', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const path = join(PATHS.refresh, 'alpha.cancel.json');
    assert.equal(await store.takeCancel('alpha', AT), undefined);
    for (const origin of [{ kind: 'person' }, { kind: 'wake' }, { kind: 'peer', from: 'lead' }, { kind: 'peer', from: null }, { kind: 'unknown' }] as const) {
      await store.setCancel('alpha', { at: AT, origin });
      assert.match(files.get(path) ?? '', /^\{"v":1,/);
      assert.deepEqual(await store.takeCancel('alpha', AT), { at: AT, origin });
      assert.equal(files.get(path), undefined, 'spent');
    }
    for (const bad of [{ at: 3 }, { origin: null }, { origin: { kind: 'robot' } }, { origin: { kind: 'peer' } }, { origin: { kind: 'peer', from: 3 } }, { v: 2 }]) {
      await files.write(path, JSON.stringify({ v: 1, at: AT, origin: { kind: 'person' }, ...bad }));
      assert.equal(await store.takeCancel('alpha', AT), undefined, JSON.stringify(bad));
      assert.equal(files.get(path), undefined, 'a damaged one is removed too');
    }
  });

  it("leaves a cancel record of another restart request for that request's runner: two requests in a row (#706)", async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const path = join(PATHS.refresh, 'alpha.cancel.json');
    const later = '2030-01-08T10:05:00.000Z';
    await store.setCancel('alpha', { at: later, origin: { kind: 'wake' } });
    assert.equal(await store.takeCancel('alpha', AT), undefined, "the replaced request's runner gets nothing");
    assert.notEqual(files.get(path), undefined, 'and leaves the record');
    assert.deepEqual(await store.takeCancel('alpha', later), { at: later, origin: { kind: 'wake' } });
    assert.equal(files.get(path), undefined, 'spent by its own runner');
  });

  it('keeps the jobs a /clear left live in a file of its own, reads a damaged one as none, and clears it', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    const jobs = { transcript: join('/', 'projects', 'app', 'second.jsonl'), crons: [{ id: 'c1', cron: '3 13 * * *', prompt: 'budget check', recurring: true, createdAt: Date.parse(AT) }] };
    assert.equal(await store.carried('alpha'), undefined);
    await store.setCarried('alpha', jobs);
    assert.deepEqual(await store.carried('alpha'), jobs);
    assert.equal(files.paths().length, 1);
    assert.match(files.get(join(PATHS.refresh, 'alpha.carried.json')) ?? '', /"c1"/);
    await files.write(join(PATHS.refresh, 'bravo.carried.json'), '{not json');
    assert.equal(await store.carried('bravo'), undefined);
    await store.clearCarried('alpha');
    await store.clearCarried('alpha');
    assert.equal(await store.carried('alpha'), undefined);
  });

  it('reads the handover from the handover folder', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    assert.equal(store.handoverPath('alpha'), join(PATHS.handover, 'alpha.md'));
    assert.equal(await store.handover('alpha'), undefined);
    await files.write(store.handoverPath('alpha'), '# In progress\n');
    assert.equal(await store.handover('alpha'), '# In progress\n');
  });
});
