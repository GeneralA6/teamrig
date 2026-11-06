import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import type { ClaudeSessionFiles } from './discover.ts';
import { formatRollup, type DayRollup } from './rollup-file.ts';
import { applyPlans, attributeInTree, foldTeam, outcomeCounts, planDays, type DayPlan, type TreeMember } from './rollup-run.ts';

const DAY = '2026-11-02';
const NEXT_DAY = '2026-11-03';
const FOLDER = '/state/usage/rollup';
const RANGE = { from: DAY, to: NEXT_DAY };

function member(team: string, sessions: readonly string[], marks: Readonly<Record<string, string>> = {}): TreeMember {
  return { team, roster: new Roster({ sessions, names: {}, roles: { lead: sessions[0] ?? 'lead' } }, team), areaBySession: new Map(Object.entries(marks)) };
}

function session(claudeSession: string, main: readonly string[] = [`/${claudeSession}.jsonl`], subagents: readonly string[] = []): ClaudeSessionFiles {
  return { claudeSession, main, subagents };
}

function titles(byPath: Readonly<Record<string, string>>): (path: string) => Promise<string | undefined> {
  return async (path) => byPath[path];
}

describe('attributeInTree', () => {
  it('leaves a session another team marked to that team, whatever its title says', async () => {
    const tree = [member('app', ['alpha']), member('web', ['bravo'], { c1: 'bravo' })];
    const sessions = [session('c1')];
    const titleOf = titles({ '/c1.jsonl': 'alpha' });
    assert.equal((await attributeInTree({ own: 'app', tree, sessions, titleOf })).size, 0);
    assert.deepEqual([...(await attributeInTree({ own: 'web', tree, sessions, titleOf })).keys()], ['bravo']);
  });

  it('gives a session two teams marked to the first of the tree, so it lands once', async () => {
    const tree = [member('app', ['alpha'], { c1: 'alpha' }), member('web', ['bravo'], { c1: 'bravo' })];
    const sessions = [session('c1')];
    const titleOf = titles({});
    assert.deepEqual([...(await attributeInTree({ own: 'app', tree, sessions, titleOf })).keys()], ['alpha']);
    assert.equal((await attributeInTree({ own: 'web', tree, sessions, titleOf })).size, 0);
  });

  it('keeps a title that names one session of the tree', async () => {
    const tree = [member('app', ['alpha']), member('web', ['bravo'])];
    const held = await attributeInTree({ own: 'web', tree, sessions: [session('c1')], titleOf: titles({ '/c1.jsonl': 'bravo' }) });
    assert.deepEqual(held.get('bravo')?.main, ['/c1.jsonl']);
  });

  it('leaves a title two teams share outside both, as neither can claim it', async () => {
    const tree = [member('app', ['alpha']), member('web', ['alpha'])];
    const input = { tree, sessions: [session('c1')], titleOf: titles({ '/c1.jsonl': 'alpha' }) };
    assert.equal((await attributeInTree({ ...input, own: 'app' })).size, 0);
    assert.equal((await attributeInTree({ ...input, own: 'web' })).size, 0);
  });

  it('skips a mark naming no session of its team, so the title still counts', async () => {
    const tree = [member('app', ['alpha']), member('web', ['bravo'], { c1: 'retired' })];
    const held = await attributeInTree({ own: 'app', tree, sessions: [session('c1')], titleOf: titles({ '/c1.jsonl': 'alpha' }) });
    assert.deepEqual([...held.keys()], ['alpha']);
  });

  it('gives a session marked in the team it left to the one team holding it now', async () => {
    const tree = [member('app', ['alpha'], { c1: 'moved' }), member('web', ['moved'])];
    const input = { tree, sessions: [session('c1')], titleOf: titles({}) };
    assert.equal((await attributeInTree({ ...input, own: 'app' })).size, 0);
    assert.deepEqual((await attributeInTree({ ...input, own: 'web' })).get('moved')?.main, ['/c1.jsonl']);
  });

  it('takes a mark its own team still holds over one a team lost, so the session lands once', async () => {
    const tree = [member('app', ['alpha'], { c1: 'moved' }), member('web', ['moved']), member('api', ['gamma'], { c1: 'gamma' })];
    const input = { tree, sessions: [session('c1')], titleOf: titles({}) };
    assert.equal((await attributeInTree({ ...input, own: 'web' })).size, 0);
    assert.deepEqual([...(await attributeInTree({ ...input, own: 'api' })).keys()], ['gamma']);
  });

  it('leaves a lost mark two teams hold to neither, as the id cannot say which', async () => {
    const tree = [member('app', ['alpha'], { c1: 'shared' }), member('web', ['shared']), member('api', ['shared'])];
    const input = { tree, sessions: [session('c1')], titleOf: titles({}) };
    assert.equal((await attributeInTree({ ...input, own: 'web' })).size, 0);
    assert.equal((await attributeInTree({ ...input, own: 'api' })).size, 0);
  });

  it('gives nothing for a team outside the tree', async () => {
    assert.equal((await attributeInTree({ own: 'gone', tree: [member('app', ['alpha'])], sessions: [session('c1')], titleOf: titles({}) })).size, 0);
  });
});

/** A reply of `input` tokens at `at`, as a transcript holds it. */
function reply(id: string, at: string, input: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: at,
    requestId: `q-${id}`,
    message: { id, role: 'assistant', model: 'model-a', usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] },
  })}\n`;
}

const NOON = `${DAY}T12:00:00.000Z`;
const NEXT_NOON = `${NEXT_DAY}T12:00:00.000Z`;

function callsOf(rollup: DayRollup | undefined, who: string): number {
  return (rollup?.rows ?? []).filter(({ session: id }) => id === who).reduce((calls, row) => calls + row.calls, 0);
}

describe('foldTeam', () => {
  it('folds each session under its own id, by day, its helper transcripts as helpers', async () => {
    const transcripts = new MemoryTranscripts({
      '/a.jsonl': reply('a1', NOON, 10) + reply('a2', NEXT_NOON, 20),
      '/a/subagents/x.jsonl': reply('a3', NOON, 30),
      '/b.jsonl': reply('b1', NOON, 40),
    });
    const byTeamSession = new Map([
      ['bravo', { main: ['/b.jsonl'], subagents: [] }],
      ['alpha', { main: ['/a.jsonl'], subagents: ['/a/subagents/x.jsonl'] }],
    ]);
    const rollups = await foldTeam(transcripts, { byTeamSession, lead: undefined, chunkBytes: 1024 });
    assert.deepEqual([...rollups.keys()], [DAY, NEXT_DAY]);
    assert.equal(callsOf(rollups.get(DAY), 'alpha'), 2);
    assert.equal(callsOf(rollups.get(DAY), 'bravo'), 1);
    assert.equal(callsOf(rollups.get(NEXT_DAY), 'alpha'), 1);
    assert.deepEqual(rollups.get(DAY)?.rows.filter(({ useClass }) => useClass === 'helper').map(({ session: id, w }) => [id, w]), [['alpha', 30]]);
  });

  it('reads a transcript in chunks smaller than the file and counts every line once', async () => {
    const lines = [1, 2, 3, 4, 5].map((id) => reply(`r${id}`, NOON, 10));
    const transcripts = new MemoryTranscripts({ '/a.jsonl': lines.join('') });
    const byTeamSession = new Map([['alpha', { main: ['/a.jsonl'], subagents: [] }]]);
    const rollups = await foldTeam(transcripts, { byTeamSession, lead: undefined, chunkBytes: (lines[0]?.length ?? 0) + 1 });
    assert.equal(callsOf(rollups.get(DAY), 'alpha'), 5);
  });

  it('stops at a last line still being written', async () => {
    const transcripts = new MemoryTranscripts({ '/a.jsonl': `${reply('a1', NOON, 10)}{"type":"assist` });
    const byTeamSession = new Map([['alpha', { main: ['/a.jsonl'], subagents: [] }]]);
    const rollups = await foldTeam(transcripts, { byTeamSession, lead: undefined, chunkBytes: 1024 });
    assert.equal(callsOf(rollups.get(DAY), 'alpha'), 1);
  });

  it('takes a reply two transcripts repeat once, whichever order the set lists them in', async () => {
    const shared = reply('a1', NOON, 10);
    const transcripts = new MemoryTranscripts({ '/a.jsonl': shared, '/b.jsonl': shared });
    const fold = (main: readonly string[]) => foldTeam(transcripts, { byTeamSession: new Map([['alpha', { main, subagents: [] }]]), lead: undefined, chunkBytes: 1024 });
    const forward = await fold(['/a.jsonl', '/b.jsonl']);
    assert.equal(callsOf(forward.get(DAY), 'alpha'), 1);
    assert.deepEqual(await fold(['/b.jsonl', '/a.jsonl']), forward);
  });

  it('marks the lead, whose calls are never plain work', async () => {
    const transcripts = new MemoryTranscripts({ '/a.jsonl': reply('a1', NOON, 10) });
    const byTeamSession = new Map([['alpha', { main: ['/a.jsonl'], subagents: [] }]]);
    const rollups = await foldTeam(transcripts, { byTeamSession, lead: 'alpha', chunkBytes: 1024 });
    assert.deepEqual(rollups.get(DAY)?.rows.map(({ useClass }) => useClass), ['lead-work']);
  });
});

const ROLLUP: DayRollup = {
  rows: [{ session: 'alpha', useClass: 'work', model: 'model-a', effort: null, w: 10, input: 10, cacheWrite: 0, cacheRead: 0, output: 0, turns: 1, calls: 1, seconds: 5 }],
  tasks: [{ session: 'alpha', task: 'T1', w: 10, seconds: 5 }],
};
const OTHER: DayRollup = { rows: ROLLUP.rows, tasks: [] };

function plansOf(files: MemoryFiles, rollups: ReadonlyMap<string, DayRollup>, range = RANGE): Promise<readonly DayPlan[]> {
  return planDays(files, { folder: FOLDER, team: 'app', range, rollups });
}

describe('planDays', () => {
  it('names each day inserted, unchanged or changed against its file, with its size', async () => {
    const files = new MemoryFiles({
      [`${FOLDER}/2026-11-01.json`]: formatRollup({ day: '2026-11-01', team: 'app', ...ROLLUP }),
      [`${FOLDER}/${DAY}.json`]: formatRollup({ day: DAY, team: 'app', ...OTHER }),
    });
    const rollups = new Map([['2026-11-01', ROLLUP], [DAY, ROLLUP], [NEXT_DAY, ROLLUP]]);
    const plans = await plansOf(files, rollups, { from: '2026-11-01', to: NEXT_DAY });
    assert.deepEqual(plans.map(({ day, outcome }) => [day, outcome]), [['2026-11-01', 'unchanged'], [DAY, 'changed'], [NEXT_DAY, 'inserted']]);
    assert.deepEqual(outcomeCounts(plans), { inserted: 1, unchanged: 1, changed: 1 });
    const [first] = plans;
    assert.equal(first?.rows, 1);
    assert.equal(first?.tasks, 1);
    assert.equal(first?.bytes, Buffer.byteLength(first?.text ?? ''));
  });

  it('leaves out a day of the transcripts outside the range, as an open day is not one to write', async () => {
    const plans = await plansOf(new MemoryFiles(), new Map([['2026-11-01', ROLLUP], [DAY, ROLLUP], ['2026-11-04', ROLLUP]]));
    assert.deepEqual(plans.map(({ day }) => day), [DAY]);
  });
});

describe('applyPlans', () => {
  it('writes a new day and leaves a changed one, whose rows on disk may be the good ones', async () => {
    const stored = formatRollup({ day: DAY, team: 'app', ...OTHER });
    const files = new MemoryFiles({ [`${FOLDER}/${DAY}.json`]: stored });
    const plans = await plansOf(files, new Map([[DAY, ROLLUP], [NEXT_DAY, ROLLUP]]));
    assert.deepEqual(await applyPlans(files, plans, false), [NEXT_DAY]);
    assert.equal(files.get(`${FOLDER}/${DAY}.json`), stored);
    assert.equal(files.get(`${FOLDER}/${NEXT_DAY}.json`), formatRollup({ day: NEXT_DAY, team: 'app', ...ROLLUP }));
  });

  it('writes a changed day with rewrite', async () => {
    const files = new MemoryFiles({ [`${FOLDER}/${DAY}.json`]: formatRollup({ day: DAY, team: 'app', ...OTHER }) });
    const plans = await plansOf(files, new Map([[DAY, ROLLUP]]));
    assert.deepEqual(await applyPlans(files, plans, true), [DAY]);
    assert.equal(files.get(`${FOLDER}/${DAY}.json`), formatRollup({ day: DAY, team: 'app', ...ROLLUP }));
  });

  it('writes nothing for a day it already holds', async () => {
    const files = new MemoryFiles({ [`${FOLDER}/${DAY}.json`]: formatRollup({ day: DAY, team: 'app', ...ROLLUP }) });
    assert.deepEqual(await applyPlans(files, await plansOf(files, new Map([[DAY, ROLLUP]])), true), []);
  });
});
