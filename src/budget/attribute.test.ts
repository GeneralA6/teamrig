import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../names/title.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { attribute, transcriptTitleOf } from './attribute.ts';
import type { ClaudeSessionFiles } from './discover.ts';

const ROSTER = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead' } }, 'app');

function session(id: string, main: readonly string[], subagents: readonly string[] = []): ClaudeSessionFiles {
  return { claudeSession: id, main, subagents };
}

const TITLES: Readonly<Record<string, string>> = {
  '/b.jsonl': 'alpha',
  '/c.jsonl': 'captain',
  '/d.jsonl': 'release checks',
  '/e2.jsonl': 'bravo',
  '/g.jsonl': 'lead',
};

async function titleOf(path: string): Promise<string | undefined> {
  return TITLES[path];
}

describe('transcriptTitleOf', () => {
  const titled = (title: string): string => `${JSON.stringify({ type: 'custom-title', customTitle: title })}\n`;

  it('reads the newest title the user gave, and none from a missing or empty transcript', async () => {
    const transcripts = new MemoryTranscripts({ '/t.jsonl': `${titled('old')}${titled('alpha')}`, '/empty.jsonl': '' });
    assert.equal(await transcriptTitleOf(transcripts, '/t.jsonl'), 'alpha');
    assert.equal(await transcriptTitleOf(transcripts, '/empty.jsonl'), undefined);
    assert.equal(await transcriptTitleOf(transcripts, '/none.jsonl'), undefined);
  });

  it('reads only the tail, so a title further back does not count', async () => {
    const transcripts = new MemoryTranscripts({ '/t.jsonl': `${titled('alpha')}${'x'.repeat(TRANSCRIPT_TAIL_BYTES)}\n` });
    assert.equal(await transcriptTitleOf(transcripts, '/t.jsonl'), undefined);
  });
});

describe('attribute', () => {
  it('goes by the inbox mark first, then by an exact id or current name, else outside', async () => {
    const result = await attribute({
      sessions: [
        session('a', ['/a.jsonl'], ['/a/subagents/x.jsonl']),
        session('b', ['/b.jsonl']),
        session('c', ['/c.jsonl']),
        session('d', ['/d.jsonl']),
        session('e', ['/e1.jsonl', '/e2.jsonl']),
        session('f', [], ['/f/subagents/y.jsonl']),
        session('g', ['/g.jsonl']),
        session('h', ['/h.jsonl']),
      ],
      team: 'app',
      roster: ROSTER,
      areaBySession: new Map([
        ['a', 'bravo'],
        ['b', 'gone'],
        ['f', 'alpha'],
      ]),
      titleOf,
    });
    assert.deepEqual([...result.byTeamSession.entries()], [
      ['bravo', { main: ['/a.jsonl', '/e1.jsonl', '/e2.jsonl'], subagents: ['/a/subagents/x.jsonl'] }],
      ['alpha', { main: ['/b.jsonl'], subagents: ['/f/subagents/y.jsonl'] }],
      ['lead', { main: ['/c.jsonl', '/g.jsonl'], subagents: [] }],
    ]);
    assert.deepEqual(result.outside, { main: ['/d.jsonl', '/h.jsonl'], subagents: [] });
    assert.equal(result.outsideSessions, 2);
    assert.deepEqual(result.outsideTitles, ['release checks']);
  });

  it('lists an outside title once', async () => {
    const result = await attribute({
      sessions: [session('d1', ['/d.jsonl']), session('d2', ['/d.jsonl'])],
      team: 'app',
      roster: ROSTER,
      areaBySession: new Map(),
      titleOf,
    });
    assert.equal(result.outsideSessions, 2);
    assert.deepEqual(result.outsideTitles, ['release checks']);
  });

  it('reads a title in the [<team>] <name> form as the team session it shows, and one of another team as outside', async () => {
    const titles: Readonly<Record<string, string>> = { '/own.jsonl': '[app] captain', '/web.jsonl': '[web] lead' };
    const result = await attribute({
      sessions: [session('own', ['/own.jsonl']), session('web', ['/web.jsonl'])],
      team: 'app',
      roster: ROSTER,
      areaBySession: new Map(),
      titleOf: async (path) => titles[path],
    });
    assert.deepEqual([...result.byTeamSession.keys()], ['lead']);
    assert.deepEqual(result.outsideTitles, ['[web] lead']);
  });
});
