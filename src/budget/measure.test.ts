import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Roster } from '../config/roster.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { replyLine, transcript, type FixtureReply } from '../testing/transcript-lines.ts';
import { measure, OUTSIDE_ID, type MeasureDeps, type MeasureInput } from './measure.ts';
import { emptyPatterns } from './patterns.ts';
import { EMPTY_USAGE, MemoryUsageStore, type UsageState } from './store.ts';

const NOW = '2030-01-08T10:00:00Z';
const DAY = '2030-01-08';
const SINCE = Date.parse('2030-01-07T00:00:00Z');
const PROJECTS = join('/', 'u', '.claude', 'projects');
const PROJECT = join(PROJECTS, 'app');
const ROSTER = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead' } }, 'app');

const TITLED_ALPHA = '0000000a-0000-4000-8000-000000000001';
const MARKED_BRAVO = '0000000b-0000-4000-8000-000000000002';
const STRANGER = '0000000c-0000-4000-8000-000000000003';
const OLD = '0000000d-0000-4000-8000-000000000004';

function path(session: string): string {
  return join(PROJECT, `${session}.jsonl`);
}

function subagent(session: string, name: string): string {
  return join(PROJECT, session, 'subagents', `${name}.jsonl`);
}

/** A reply of `input` plain input tokens, so its W is `input`. */
function reply(id: string, input: number): string {
  const fixture: FixtureReply = { id, requestId: `q-${id}`, at: `${DAY}T09:00:00.000Z`, usage: { input } };
  return replyLine(fixture);
}

const TITLES: Readonly<Record<string, string>> = { [path(TITLED_ALPHA)]: 'alpha', [path(STRANGER)]: 'release checks' };

interface World {
  readonly deps: MeasureDeps;
  readonly team: MemoryUsageStore;
  readonly outside: MemoryUsageStore;
  readonly input: MeasureInput;
}

function world(input: Partial<MeasureInput> = {}): World {
  const changed = Date.parse(NOW);
  const transcripts = new MemoryTranscripts();
  transcripts.set(path(TITLED_ALPHA), transcript([reply('a1', 100), reply('a2', 20)]), changed);
  transcripts.set(subagent(TITLED_ALPHA, 'agent-1'), transcript([reply('a3', 5)]), changed);
  transcripts.set(subagent(MARKED_BRAVO, 'agent-2'), transcript([reply('b1', 40)]), changed);
  transcripts.set(path(STRANGER), transcript([reply('c1', 7)]), changed);
  transcripts.set(path(OLD), transcript([reply('d1', 1_000)]), SINCE - 1);
  const team = new MemoryUsageStore();
  const outside = new MemoryUsageStore();
  return {
    deps: { transcripts, titleOf: async (file) => TITLES[file], team, outside, clock: new FakeClock(NOW) },
    team,
    outside,
    input: {
      projectsDir: PROJECTS,
      since: SINCE,
      team: 'app',
      roster: ROSTER,
      areaBySession: new Map([[MARKED_BRAVO, 'bravo']]),
      peers: [],
      subagentWeight: 1,
      chunkBytes: 1_000_000,
      maxRuns: 4,
      ...input,
    },
  };
}

function wOn(state: UsageState | undefined): number | undefined {
  return state?.byDay[DAY]?.w;
}

describe('measure', () => {
  it("meters each team session's transcripts under its id and everyone else's under the outside id", async () => {
    const { deps, input, team, outside } = world();
    const measured = await measure(deps, input);
    assert.deepEqual(
      ROSTER.ids.map((id) => wOn(measured.bySession.get(id))),
      [undefined, 125, 40],
    );
    assert.equal(wOn(measured.outside), 7);
    assert.deepEqual([measured.outsideSessions, measured.outsideTitles, measured.behind], [1, ['release checks'], []]);
    assert.equal(wOn((await team.load('alpha')).state), 125);
    assert.equal(wOn((await outside.load(OUTSIDE_ID)).state), 7);
  });

  it("counts each subagent's W at the subagent weight", async () => {
    const { deps, input } = world({ subagentWeight: 3 });
    const measured = await measure(deps, input);
    assert.deepEqual(
      ROSTER.ids.map((id) => wOn(measured.bySession.get(id))),
      [undefined, 120 + 3 * 5, 3 * 40],
    );
    assert.equal(wOn(measured.outside), 7);
  });

  it('only loads a session with no transcripts, and the outside store when no one is outside', async () => {
    const { deps, input, outside } = world({ areaBySession: new Map([[MARKED_BRAVO, 'bravo'], [STRANGER, 'lead']]) });
    const stored: UsageState = { byDay: { [DAY]: { w: 9, calls: 1, patterns: emptyPatterns() } }, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
    assert.equal(await outside.save(OUTSIDE_ID, stored, 0), true);
    const measured = await measure(deps, { ...input, roster: new Roster({ sessions: ['lead', 'alpha', 'bravo', 'charlie'], names: {}, roles: { lead: 'lead' } }, 'app') });
    assert.equal(wOn(measured.bySession.get('lead')), 7);
    assert.deepEqual(measured.bySession.get('charlie'), EMPTY_USAGE);
    assert.equal(measured.outside, stored);
    assert.equal((await outside.load(OUTSIDE_ID)).rev, 1);
    assert.equal(measured.outsideSessions, 0);
  });

  it("leaves a tab a peer team's mark binds to that team's own meter, out of the outside store", async () => {
    const { deps, input, outside } = world({ peers: [{ ids: ['ops'], areaBySession: new Map([[STRANGER, 'ops']]) }] });
    const measured = await measure(deps, input);
    assert.deepEqual(
      ROSTER.ids.map((id) => wOn(measured.bySession.get(id))),
      [undefined, 125, 40],
    );
    assert.equal(wOn(measured.outside), undefined);
    assert.deepEqual([measured.outsideSessions, measured.outsideTitles], [0, []]);
    assert.equal(wOn((await outside.load(OUTSIDE_ID)).state), undefined);
  });

  it('names the sessions still behind after the most runs, and catches them up on the next measure', async () => {
    const { deps, input } = world({ chunkBytes: 1, maxRuns: 1 });
    const first = await measure(deps, input);
    // A run reads at least one whole line, so bravo's and the outsider's single lines are read whole; alpha's three are not.
    assert.deepEqual(first.behind, ['alpha']);
    const caught = await measure(deps, { ...input, chunkBytes: 1_000_000 });
    assert.deepEqual(caught.behind, []);
    assert.equal(wOn(caught.bySession.get('alpha')), 125);
  });
});
