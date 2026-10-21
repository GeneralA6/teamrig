import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import {
  agentListingLine,
  compactLine,
  deferredToolsLine,
  mcpInstructionsLine,
  resultsLine,
  skillListingLine,
  transcript,
} from '../testing/transcript-lines.ts';
import { foldSessionLists, readSessionLists, type SessionList, type SessionListKind } from './session-lists.ts';

const ROOT = join('/', 'u', '.claude', 'projects');
const PROJECT = join('/', 'srv', 'app');
const OLDER = '0123abcd-0000-4000-8000-00000000000a';
const NEWER = '0123abcd-0000-4000-8000-00000000000b';

function listOf(lists: readonly SessionList[], kind: SessionListKind): SessionList | undefined {
  return lists.find((list) => list.kind === kind);
}

describe('foldSessionLists', () => {
  it('measures each list by source, largest first', () => {
    const lists = foldSessionLists(
      transcript([
        // "- a: " + 10 and a line end = 16; "- b: " + 20 and a line end = 26; "- tr:guide: " + 5 = 17.
        skillListingLine([
          { name: 'a', description: 'x'.repeat(10) },
          { name: 'b', description: 'y'.repeat(20) },
          { name: 'tr:guide', description: 'z'.repeat(5) },
        ]),
        // A listed tool is its name and a line end; a surfaced one its whole definition, here 54 characters of JSON.
        deferredToolsLine({
          added: ['Monitor', 'mcp__docs__read', 'mcp__docs__batch'],
          surfaced: [{ name: 'mcp__docs__batch', description: 'd'.repeat(10) }],
        }),
        // "- claude: " + 10, "- tr:reviewer: " + 5, "- mine: " + 6, each with a line end.
        agentListingLine({
          added: [
            { name: 'claude', description: 'c'.repeat(10) },
            { name: 'tr:reviewer', description: 'r'.repeat(5) },
            { name: 'mine', description: 'm'.repeat(6) },
          ],
          builtIn: ['claude'],
        }),
        mcpInstructionsLine([{ name: 'docs', description: 'i'.repeat(40) }]),
      ]),
    );
    assert.deepEqual(lists, [
      {
        kind: 'skills',
        count: 3,
        chars: 59,
        sources: [
          { name: 'skills folders and built-in', count: 2, chars: 42 },
          { name: 'tr', count: 1, chars: 17 },
        ],
      },
      {
        kind: 'tools',
        count: 3,
        chars: 78,
        sources: [
          { name: 'docs', count: 2, chars: 70 },
          { name: 'built-in', count: 1, chars: 8 },
        ],
      },
      {
        kind: 'agents',
        count: 3,
        chars: 57,
        sources: [
          { name: 'built-in', count: 1, chars: 21 },
          { name: 'tr', count: 1, chars: 21 },
          { name: 'agents folders', count: 1, chars: 15 },
        ],
      },
      { kind: 'instructions', count: 1, chars: 41, sources: [{ name: 'docs', count: 1, chars: 41 }] },
    ]);
  });

  it('keeps entries by name across re-announcements, replaces on an initial listing and applies removals', () => {
    const lists = foldSessionLists(
      transcript([
        skillListingLine([
          { name: 'a', description: 'x' },
          { name: 'b', description: 'y' },
        ]),
        skillListingLine([{ name: 'c', description: 'z' }], false),
        deferredToolsLine({ added: ['Monitor', 'mcp__docs__read'] }),
        agentListingLine({ added: [{ name: 'mine', description: 'm' }] }),
        mcpInstructionsLine([
          { name: 'docs', description: 'i' },
          { name: 'mail', description: 'j' },
        ]),
        compactLine('2026-10-21T10:00:00Z'),
        skillListingLine([{ name: 'a', description: 'x' }]),
        deferredToolsLine({ added: ['Monitor'], removed: ['mcp__docs__read'] }),
        agentListingLine({ added: [{ name: 'Plan', description: 'p' }], builtIn: ['Plan'], initial: false }),
        mcpInstructionsLine([], ['mail']),
      ]),
    );
    assert.deepEqual(listOf(lists, 'skills'), { kind: 'skills', count: 1, chars: 6, sources: [{ name: 'skills folders and built-in', count: 1, chars: 6 }] });
    assert.deepEqual(listOf(lists, 'tools'), { kind: 'tools', count: 1, chars: 8, sources: [{ name: 'built-in', count: 1, chars: 8 }] });
    assert.deepEqual(listOf(lists, 'agents')?.sources, [
      { name: 'agents folders', count: 1, chars: 10 },
      { name: 'built-in', count: 1, chars: 10 },
    ]);
    assert.deepEqual(listOf(lists, 'instructions'), { kind: 'instructions', count: 1, chars: 2, sources: [{ name: 'docs', count: 1, chars: 2 }] });
  });

  it('gives a skill its text up to the next one, a description over several lines too, and a name the listing lacks 0', () => {
    const line = JSON.stringify({
      attachment: { type: 'skill_listing', content: 'header\n- a: one\ntwo\n- b: three', isInitial: true, names: ['a', 'tr:ghost', 'b'] },
      type: 'attachment',
    });
    assert.deepEqual(listOf(foldSessionLists(transcript([line])), 'skills')?.sources, [
      { name: 'skills folders and built-in', count: 2, chars: 30 },
      { name: 'tr', count: 1, chars: 0 },
    ]);
  });

  it('counts a tool surfaced on its own with its definition', () => {
    const lists = foldSessionLists(transcript([deferredToolsLine({ surfaced: [{ name: 'Monitor', description: 'watch' }] })]));
    assert.deepEqual(listOf(lists, 'tools'), { kind: 'tools', count: 1, chars: 40, sources: [{ name: 'built-in', count: 1, chars: 40 }] });
  });

  it('skips tool output that quotes a list, damaged lines and lines without an attachment', () => {
    const lists = foldSessionLists(
      transcript([
        resultsLine('2026-10-21T10:00:00Z', [{ id: 't1', text: skillListingLine([{ name: 'a', description: 'x' }]) }]),
        '{"attachment":{"type":"skill_listing","names":["a"],"content":"- a: x"',
        JSON.stringify({ type: 'skill_listing', names: ['a'], content: '- a: x' }),
        JSON.stringify({ attachment: { type: 'other', note: '"type":"skill_listing"' } }),
      ]),
    );
    assert.deepEqual(
      lists.map((list) => [list.kind, list.count, list.chars]),
      [
        ['skills', 0, 0],
        ['tools', 0, 0],
        ['agents', 0, 0],
        ['instructions', 0, 0],
      ],
    );
  });
});

describe('readSessionLists', () => {
  const dir = join(ROOT, claudeProjectSlug(PROJECT));

  it("folds the project's newest session transcript", async () => {
    const transcripts = new MemoryTranscripts();
    transcripts.set(join(dir, `${OLDER}.jsonl`), transcript([skillListingLine([{ name: 'old', description: 'x' }])]), 1);
    transcripts.set(join(dir, `${NEWER}.jsonl`), transcript([skillListingLine([{ name: 'new', description: 'x' }])]), 2);
    const read = await readSessionLists(transcripts, ROOT, PROJECT);
    assert.equal(read?.transcript, join(dir, `${NEWER}.jsonl`));
    assert.deepEqual(read === undefined ? undefined : listOf(read.lists, 'skills')?.count, 1);
    assert.deepEqual(read === undefined ? undefined : listOf(read.lists, 'skills')?.chars, 8);
  });

  it('is undefined for a project with no session transcript', async () => {
    assert.equal(await readSessionLists(new MemoryTranscripts(), ROOT, PROJECT), undefined);
  });
});
