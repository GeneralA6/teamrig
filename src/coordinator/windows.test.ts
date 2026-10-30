import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeployRecord, LedgerMdDeploy, LedgerRecord, LoadRecord } from './ledger.ts';
import { cleanWindows, disruptions, loadsDuring, loadsOf, type Disruption, type DisruptionInputs, type Load } from './windows.ts';

const MINUTE = 60_000;

/** A time on 2030-01-08, UTC. */
function at(time: string): number {
  return Date.parse(`2030-01-08T${time}:00Z`);
}

function iso(time: string): string {
  return new Date(at(time)).toISOString();
}

const TARGETS: Readonly<Record<string, readonly string[]>> = { pipeline: ['api', 'workers'], site: ['cloud-web'] };

function inputs(md: readonly LedgerMdDeploy[], records: readonly LedgerRecord[], nowMs: number = at('18:00')): DisruptionInputs {
  return { md, records, targetsOf: (repo) => TARGETS[repo] ?? [], settleMs: 30 * MINUTE, assumedDeployMs: 20 * MINUTE, lockTtlMs: 150 * MINUTE, nowMs };
}

function line(time: string, session: string, repo: string): LedgerMdDeploy {
  return { rolledAt: at(time), session, repo, kind: 'deploy' };
}

function deploy(started: string, deployed: string, session: string, repo: string): DeployRecord {
  return { type: 'deploy', kind: 'deploy', session, repo, range: 'aaaaaaaa..bbbbbbbb', what: 'deploy', note: '', startedAt: iso(started), rolledAt: new Date(at(deployed) + 20_000).toISOString() };
}

function heavy(id: string, started: string, ended: string | null): LedgerRecord {
  return { type: 'heavy', id, session: 'dev', what: 'tests', startedAt: iso(started), endedAt: ended === null ? null : iso(ended), exitCode: ended === null ? null : 0 };
}

function load(id: string, started: string, ended: string | null, targets: LoadRecord['targets'] = 'host'): LoadRecord {
  return { type: 'load', id, session: 'ops', what: 'db trim', targets, startedAt: iso(started), endedAt: ended === null ? null : iso(ended) };
}

describe('disruptions', () => {
  it('starts a deploy at its record of the same session and repository, else assumes how long it ran, and lets its targets settle', () => {
    const md = [line('10:00', 'ops', 'pipeline'), line('12:00', 'web', 'site'), line('14:00', 'ops', 'other')];
    const records = [deploy('09:50', '10:00', 'ops', 'pipeline'), deploy('11:00', '12:00', 'ops', 'site'), deploy('11:30', '12:00', 'web', 'pipeline')];
    assert.deepEqual(disruptions(inputs(md, records)), [
      { from: at('09:50'), to: at('10:30'), targets: ['api', 'workers'] },
      { from: at('11:40'), to: at('12:30'), targets: ['cloud-web'] },
      { from: at('13:40'), to: at('14:30'), targets: [] },
    ]);
  });

  it('lets a deploy that restarted some of its repository’s targets disturb only those', () => {
    const some: DeployRecord = { ...deploy('09:55', '10:00', 'sec', 'pipeline'), targets: ['workers'] };
    assert.deepEqual(disruptions(inputs([line('10:00', 'sec', 'pipeline')], [some])), [{ from: at('09:55'), to: at('10:30'), targets: ['workers'] }]);
  });

  it('reads a queued step as the whole host, its end record winning', () => {
    assert.deepEqual(disruptions(inputs([], [heavy('h1', '09:00', null), heavy('h1', '09:00', '09:20'), heavy('h1', '09:00', null)])), [{ from: at('09:00'), to: at('09:20'), targets: 'host' }]);
  });

  it('ends an unfinished queued step at the next one’s start, now or its lock’s time to live, whichever comes first', () => {
    const records = [heavy('a', '09:00', null), heavy('b', '09:30', '09:40'), heavy('c', '15:00', null), heavy('d', '17:00', null)];
    assert.deepEqual(
      disruptions(inputs([], records)).map((found) => [found.from, found.to]),
      [
        [at('09:00'), at('09:30')],
        [at('09:30'), at('09:40')],
        [at('15:00'), at('17:00')],
        [at('17:00'), at('18:00')],
      ],
    );
    assert.deepEqual(disruptions(inputs([], [heavy('a', '09:00', null)])), [{ from: at('09:00'), to: at('11:30'), targets: 'host' }]);
  });
});

describe('loadsOf', () => {
  it('reads one job per id, its end record winning, and runs an open one until now', () => {
    const records = [load('l1', '09:00', null), heavy('h1', '09:30', '09:40'), load('l2', '10:00', null, ['api']), load('l1', '09:00', '11:00')];
    assert.deepEqual(loadsOf(records, at('18:00')), [
      { id: 'l1', session: 'ops', what: 'db trim', targets: 'host', from: at('09:00'), to: at('11:00'), open: false },
      { id: 'l2', session: 'ops', what: 'db trim', targets: ['api'], from: at('10:00'), to: at('18:00'), open: true },
    ]);
  });
});

describe('loadsDuring', () => {
  it('names the jobs on the target, or on the whole host, that overlap the window', () => {
    const loads: Load[] = loadsOf([load('host', '08:00', '10:30'), load('api', '11:00', null, ['api']), load('workers', '10:00', null, ['workers']), load('early', '08:00', '09:00', ['api'])], at('18:00'));
    assert.deepEqual(
      loadsDuring(loads, 'api', { from: at('10:00'), to: at('12:00') }).map((found) => found.id),
      ['host', 'api'],
    );
  });
});

describe('cleanWindows', () => {
  function disruption(from: string, to: string, targets: Disruption['targets']): Disruption {
    return { from: at(from), to: at(to), targets };
  }

  const ALL = [
    disruption('10:00', '10:30', ['api']),
    disruption('10:20', '11:00', 'host'),
    disruption('12:00', '12:10', ['cloud-web']),
    disruption('13:00', '13:05', ['api', 'workers']),
    disruption('16:00', '19:00', ['api']),
    disruption('07:00', '08:00', ['api']),
  ];

  it('lists the stretches of the span no disruption of the target covers, each at least the minimum', () => {
    const span = { from: at('09:00'), to: at('17:00') };
    assert.deepEqual(cleanWindows(ALL, 'api', span, 15 * MINUTE), [
      { from: at('09:00'), to: at('10:00') },
      { from: at('11:00'), to: at('13:00') },
      { from: at('13:05'), to: at('16:00') },
    ]);
    assert.deepEqual(cleanWindows(ALL, 'api', span, 90 * MINUTE), [
      { from: at('11:00'), to: at('13:00') },
      { from: at('13:05'), to: at('16:00') },
    ]);
  });

  it('is the whole span when nothing disturbs the target in it', () => {
    assert.deepEqual(cleanWindows(ALL, 'cloud-web', { from: at('13:00'), to: at('14:00') }, 15 * MINUTE), [{ from: at('13:00'), to: at('14:00') }]);
  });
});
