import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { withdrawnLock } from '../testing/withdrawn-lock.ts';
import type { FreezePorts } from './freeze-store.ts';
import { HostLock, type HostLockInfo } from './host-lock.ts';
import {
  addPipelineFreeze,
  endPipelineFreeze,
  frozenReason,
  holdingFreeze,
  liveFreezes,
  parsePipelineFreezes,
  pipelineFreezeText,
  PIPELINE_FREEZES_LOCK_TTL_MS,
  type PipelineFreeze,
  type PipelineFreezeRequest,
} from './pipeline-freezes.ts';

const PLACES = { pipelineFreezes: '/team/deploys/pipeline-freezes.json' };
const LOCK = '/team/deploys/pipeline-freezes.lock';
const SCANNER = new SecretScanner();
const NOW = '2030-01-08T10:00:00.000Z';
const REQUEST: PipelineFreezeRequest = { session: 'po', from: new Date('2030-01-08T12:00:00Z'), to: new Date('2030-01-08T14:00:00Z'), reason: 'PC  down\nfor a disk swap' };

/** A merge-only freeze holding now, one still to come, and one that ended 8 days ago. */
const KEPT: readonly PipelineFreeze[] = [
  { id: 'F3', session: 'teamrig', from: '2030-01-08T09:00:00.000Z', to: '2030-01-08T11:00:00.000Z', reason: 'release', kinds: ['merge'], at: '2030-01-08T08:00:00.000Z' },
  { id: 'F4', session: 'po', from: '2030-01-09T00:00:00.000Z', to: '2030-01-09T02:00:00.000Z', reason: 'backup', at: '2030-01-08T08:30:00.000Z' },
  { id: 'F7', session: 'po', from: '2029-12-30T00:00:00.000Z', to: '2029-12-31T00:00:00.000Z', reason: 'old', at: '2029-12-29T00:00:00.000Z' },
];

interface World {
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly ports: FreezePorts;
}

function world(initial: Readonly<Record<string, string>> = {}): World {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock(NOW);
  const lock = new HostLock(LOCK, PIPELINE_FREEZES_LOCK_TTL_MS, { files, clock, sleep: clock.sleep, pid: 7, alive: (pid) => pid === 7 || pid === 9, newId: () => 'pf-1', zone: TimeZone.UTC });
  return { files, clock, ports: { files, clock, zone: TimeZone.UTC, lock } };
}

function freezesIn(files: MemoryFiles): unknown {
  return JSON.parse(files.get(PLACES.pipelineFreezes) ?? 'null');
}

describe('parsePipelineFreezes', () => {
  it('reads no file as no freezes, and text that is no JSON array as unreadable', () => {
    assert.deepEqual(parsePipelineFreezes(undefined), { kind: 'read', freezes: [] });
    assert.deepEqual(parsePipelineFreezes('[{"id":'), { kind: 'unreadable', reason: 'not JSON' });
    assert.deepEqual(parsePipelineFreezes('{}'), { kind: 'unreadable', reason: 'not a JSON array' });
  });

  it('skips an entry missing a field, with a time that does not parse, or with an unknown or empty kind list', () => {
    const good = KEPT[0];
    const text = JSON.stringify([good, { ...good, id: undefined }, { ...good, to: 'soon' }, { ...good, kinds: ['merge', 'nap'] }, { ...good, kinds: [] }, KEPT[1]]);
    assert.deepEqual(parsePipelineFreezes(text), { kind: 'read', freezes: [good, KEPT[1]] });
  });
});

describe('holdingFreeze', () => {
  const now = Date.parse(NOW);

  it('holds a step whose kind the freeze names, or any step for a freeze naming none, only between its start and end', () => {
    assert.equal(holdingFreeze(KEPT, now, 'merge')?.id, 'F3');
    assert.equal(holdingFreeze(KEPT, now, 'test'), undefined, 'F3 holds merges only');
    assert.equal(holdingFreeze(KEPT, Date.parse('2030-01-09T01:00:00Z'), 'test')?.id, 'F4');
    assert.equal(holdingFreeze(KEPT, Date.parse('2030-01-09T02:00:00Z'), 'test'), undefined, 'a freeze ends at its end');
    assert.equal(holdingFreeze(KEPT, Date.parse('2030-01-08T09:00:00Z'), 'merge')?.id, 'F3', 'a freeze holds from its start');
  });

  it('lists the freezes not yet ended', () => {
    assert.deepEqual(liveFreezes(KEPT, now).map((freeze) => freeze.id), ['F3', 'F4']);
  });
});

describe('freeze texts', () => {
  it('name the end, who set it, why, its id and how it ends early', () => {
    assert.equal(frozenReason(KEPT[0]!, TimeZone.UTC), 'the pipeline is frozen until 2030-01-08 11:00 UTC by teamrig (release; F3); no new step starts until then. The lead or the delivery owner ends it early with: teamrig pipeline unfreeze F3');
    assert.equal(pipelineFreezeText(KEPT[0]!, TimeZone.UTC), 'F3 2030-01-08 09:00 UTC → 2030-01-08 11:00 UTC, merge, by teamrig (release)');
    assert.equal(pipelineFreezeText(KEPT[1]!, TimeZone.UTC), 'F4 2030-01-09 00:00 UTC → 2030-01-09 02:00 UTC, all steps, by po (backup)');
  });
});

describe('addPipelineFreeze', () => {
  it('adds the freeze with the next id, its reason on one line, and drops ones ended over 7 days ago', async () => {
    const { files, ports } = world({ [PLACES.pipelineFreezes]: JSON.stringify(KEPT) });
    const outcome = await addPipelineFreeze(ports, PLACES, SCANNER, { ...REQUEST, kinds: ['test', 'build'] });
    const freeze = { id: 'F5', session: 'po', from: '2030-01-08T12:00:00.000Z', to: '2030-01-08T14:00:00.000Z', reason: 'PC down for a disk swap', kinds: ['test', 'build'], at: NOW };
    assert.deepEqual(outcome, { kind: 'done', value: freeze });
    assert.deepEqual(freezesIn(files), [KEPT[0], KEPT[1], freeze]);
    assert.equal(files.get(LOCK), undefined, 'the lock is released');
  });

  it('starts as F1 with no file, reads a start in the past minute as now, and stores no kinds for every kind', async () => {
    const { files, ports } = world();
    const outcome = await addPipelineFreeze(ports, PLACES, SCANNER, { ...REQUEST, from: new Date('2030-01-08T09:59:30Z') });
    const freeze = { id: 'F1', session: 'po', from: NOW, to: '2030-01-08T14:00:00.000Z', reason: 'PC down for a disk swap', at: NOW };
    assert.deepEqual([outcome, freezesIn(files)], [{ kind: 'done', value: freeze }, [freeze]]);
  });

  it('refuses, before taking the lock, a start in the past, an end not after the start, over 7 days, no kinds, no reason or a secret', async () => {
    const { files, ports } = world();
    const refusals = await Promise.all(
      [
        { ...REQUEST, from: new Date('2030-01-08T09:58:00Z') },
        { ...REQUEST, to: REQUEST.from },
        { ...REQUEST, to: new Date('2030-01-15T12:01:00Z') },
        { ...REQUEST, kinds: [] },
        { ...REQUEST, reason: ' \n' },
        { ...REQUEST, reason: ['reboot with password', '=', 'hunter2'].join('') },
      ].map(async (request) => addPipelineFreeze(ports, PLACES, SCANNER, request)),
    );
    assert.deepEqual(refusals, [
      { kind: 'refused', reason: 'a freeze starts now or later, never in the past' },
      { kind: 'refused', reason: 'a freeze ends after it starts' },
      { kind: 'refused', reason: 'a freeze lasts at most 7 days (asked 169 h)' },
      { kind: 'refused', reason: 'a freeze names at least one step kind, or none for every kind' },
      { kind: 'refused', reason: 'a freeze says why it holds the pipeline' },
      { kind: 'refused', reason: 'the reason looks like it holds a secret (password or key assignment); refer to where it is kept instead' },
    ]);
    assert.equal(files.get(PLACES.pipelineFreezes), undefined);
  });

  it('leaves an unreadable file as it is', async () => {
    const { files, ports } = world({ [PLACES.pipelineFreezes]: '[{"id":' });
    assert.deepEqual(await addPipelineFreeze(ports, PLACES, SCANNER, REQUEST), { kind: 'refused', reason: '/team/deploys/pipeline-freezes.json is unreadable (not JSON), so it is left as it is' });
    assert.equal(files.get(PLACES.pipelineFreezes), '[{"id":');
  });

  it('is busy, writing nothing, while another writer holds the lock past the wait', async () => {
    const other = JSON.stringify({ token: 'pf', pid: 9, session: 'teamrig', purpose: 'pipeline freezes write', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:59:50.000Z', expiresAt: '2030-01-08T10:00:50.000Z' });
    const { files, clock, ports } = world({ [LOCK]: other });
    const outcome = await addPipelineFreeze(ports, PLACES, SCANNER, REQUEST);
    assert.deepEqual(outcome, { kind: 'busy', reason: 'the pipeline freezes are being written (teamrig (pipeline freezes write) since 2030-01-08 09:59 UTC); try again' });
    assert.equal(clock.now(), Date.parse('2030-01-08T10:00:15Z'), 'it waited the 15 s');
    assert.deepEqual([files.get(PLACES.pipelineFreezes), files.get(LOCK)], [undefined, other]);
  });

  it('is busy, writing nothing, when its place in line was withdrawn', async () => {
    const { files, ports } = world();
    const released: HostLockInfo[] = [];
    const outcome = await addPipelineFreeze({ ...ports, lock: withdrawnLock(released) }, PLACES, SCANNER, REQUEST);
    assert.deepEqual([outcome, released, files.get(PLACES.pipelineFreezes)], [{ kind: 'busy', reason: 'its place in line for the pipeline freezes was withdrawn; try again' }, [], undefined]);
  });
});

describe('endPipelineFreeze', () => {
  it('ends a holding freeze now and keeps its record', async () => {
    const { files, ports } = world({ [PLACES.pipelineFreezes]: JSON.stringify(KEPT) });
    const ended = { ...KEPT[0]!, to: NOW };
    assert.deepEqual(await endPipelineFreeze(ports, PLACES, 'teamrig', 'F3'), { kind: 'done', value: ended });
    assert.deepEqual(freezesIn(files), [ended, KEPT[1]]);
  });

  it('drops a freeze still to come', async () => {
    const { files, ports } = world({ [PLACES.pipelineFreezes]: JSON.stringify(KEPT) });
    assert.deepEqual(await endPipelineFreeze(ports, PLACES, 'teamrig', 'F4'), { kind: 'done', value: KEPT[1] });
    assert.deepEqual(freezesIn(files), [KEPT[0]]);
  });

  it('refuses an id no live freeze has, naming the live ones, and writes nothing', async () => {
    const text = JSON.stringify(KEPT);
    const { files, ports } = world({ [PLACES.pipelineFreezes]: text });
    assert.deepEqual(await endPipelineFreeze(ports, PLACES, 'teamrig', 'F7'), { kind: 'refused', reason: 'no live pipeline freeze is F7 (live: F3, F4)' });
    assert.deepEqual(await endPipelineFreeze(world().ports, PLACES, 'teamrig', 'F1'), { kind: 'refused', reason: 'no live pipeline freeze is F1 (live: none)' });
    assert.equal(files.get(PLACES.pipelineFreezes), text);
  });
});
