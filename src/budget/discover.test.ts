import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { claudeProjectsDir, discoverTranscripts, nodeTranscriptFolders, nodeTranscriptSource } from './discover.ts';

const ROOT = join('/', 'u', '.claude', 'projects');
const A = '0123abcd-0000-4000-8000-00000000000a';
const B = '0123abcd-0000-4000-8000-00000000000b';
const C = '0123abcd-0000-4000-8000-00000000000c';
const SINCE = Date.parse('2026-10-14T00:00:00Z');
const TODAY = SINCE + 3_600_000;
const YESTERDAY = SINCE - 3_600_000;

describe('claudeProjectsDir', () => {
  it('uses $CLAUDE_CONFIG_DIR, else the home folder', () => {
    assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }, join('/', 'u')), join('/', 'cfg', 'projects'));
    assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: ' ' }, join('/', 'u')), ROOT);
    assert.equal(claudeProjectsDir({}, join('/', 'u')), ROOT);
  });
});

describe('discoverTranscripts', () => {
  it('finds each session written since the start, with its subagents, across projects', async () => {
    const transcripts = new MemoryTranscripts();
    transcripts.set(join(ROOT, 'p1', `${A}.jsonl`), 'a', TODAY);
    transcripts.set(join(ROOT, 'p1', A, 'subagents', 'agent-2.jsonl'), 's', TODAY);
    transcripts.set(join(ROOT, 'p1', A, 'subagents', 'agent-1.jsonl'), 's', TODAY);
    transcripts.set(join(ROOT, 'p1', A, 'subagents', 'agent-0.jsonl'), 'old', YESTERDAY);
    transcripts.set(join(ROOT, 'p2', `${A}.jsonl`), 'a again', TODAY);
    transcripts.set(join(ROOT, 'p1', `${B}.jsonl`), 'b', YESTERDAY);
    transcripts.set(join(ROOT, 'p2', C, 'subagents', 'agent-9.jsonl'), 'c', TODAY);
    transcripts.set(join(ROOT, 'p2', C, 'tool-results', 'x.txt'), 'c', TODAY);
    transcripts.set(join(ROOT, 'p2', 'notes.jsonl'), 'not a session', TODAY);
    transcripts.set(join(ROOT, 'p2', 'memory', 'x.md'), 'not a session', TODAY);
    transcripts.set(join(ROOT, 'stray.jsonl'), 'outside a project', TODAY);

    assert.deepEqual(await discoverTranscripts(transcripts, ROOT, SINCE), [
      {
        claudeSession: A,
        main: [join(ROOT, 'p1', `${A}.jsonl`), join(ROOT, 'p2', `${A}.jsonl`)],
        subagents: [join(ROOT, 'p1', A, 'subagents', 'agent-1.jsonl'), join(ROOT, 'p1', A, 'subagents', 'agent-2.jsonl')],
      },
      { claudeSession: C, main: [], subagents: [join(ROOT, 'p2', C, 'subagents', 'agent-9.jsonl')] },
    ]);
  });

  it('finds nothing in a missing folder', async () => {
    assert.deepEqual(await discoverTranscripts(new MemoryTranscripts(), ROOT, SINCE), []);
  });
});

describe('nodeTranscriptFolders', () => {
  let dir = '';

  before(async () => {
    dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'discover-')));
    await mkdir(join(dir, 'p1', A, 'subagents'), { recursive: true });
    await writeFile(join(dir, 'p1', `${A}.jsonl`), '{}\n');
    await writeFile(join(dir, 'p1', A, 'subagents', 'agent-1.jsonl'), '{}\n');
    const old = new Date(YESTERDAY);
    await utimes(join(dir, 'p1', A, 'subagents', 'agent-1.jsonl'), old, old);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists files and folders with their last change', async () => {
    const entries = await nodeTranscriptFolders.entries(join(dir, 'p1'));
    assert.deepEqual(entries.map((entry) => [entry.name, entry.folder]).sort(), [
      [A, true],
      [`${A}.jsonl`, false],
    ]);
    const [sub] = await nodeTranscriptFolders.entries(join(dir, 'p1', A, 'subagents'));
    assert.equal(sub?.changedAt, YESTERDAY);
  });

  it('lists nothing for a missing folder or a file', async () => {
    assert.deepEqual(await nodeTranscriptFolders.entries(join(dir, 'missing')), []);
    assert.deepEqual(await nodeTranscriptFolders.entries(join(dir, 'p1', `${A}.jsonl`)), []);
  });

  it('discovers through the real filesystem and reads the bytes', async () => {
    const found = await discoverTranscripts(nodeTranscriptSource, dir, SINCE);
    assert.deepEqual(found, [{ claudeSession: A, main: [join(dir, 'p1', `${A}.jsonl`)], subagents: [] }]);
    assert.equal(await nodeTranscriptSource.size(join(dir, 'p1', `${A}.jsonl`)), 3);
  });
});
