import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine } from '../testing/transcript-lines.ts';
import { readSkillUse } from './scan-usage.ts';

const PROJECTS = resolve('/', 'u', '.claude', 'projects');
const AT = '2030-01-08T10:00:00Z';
const SINCE = 1_000;
const RECENT = 2_000;

function skillCall(skill: string): string {
  return replyLine({ id: `m-${skill}`, at: AT, usage: { input: 1, output: 1 }, tools: [{ id: `t-${skill}`, name: 'Skill', skill }] });
}

describe('readSkillUse', () => {
  it("names the skills Skill calls loaded and slash commands ran, in sessions' and subagents' transcripts written since then", async () => {
    const main = [skillCall('alpha-check'), promptLine(AT, '<command-name>/beta-run</command-name>'), promptLine(AT, 'mentions "Skill" in passing'), ''].join('\n');
    const sub = `${skillCall('tr:guide')}\n`;
    const old = `${skillCall('gamma-old')}\n`;
    const source = new MemoryTranscripts();
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl'), main, RECENT);
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a', 'subagents', 'agent-1.jsonl'), sub, RECENT);
    source.set(join(PROJECTS, 'other', '0123abcd-0000-4000-8000-00000000000b.jsonl'), old, SINCE - 1);
    const use = await readSkillUse(source, PROJECTS, SINCE, 16);
    assert.deepEqual([...use.used].sort(), ['alpha-check', 'beta-run', 'tr:guide']);
    assert.equal(use.transcripts, 2);
    assert.equal(use.bytes, Buffer.byteLength(main) + Buffer.byteLength(sub));
  });

  it('reads nothing when no transcript was written since then', async () => {
    const source = new MemoryTranscripts({ [join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl')]: `${skillCall('alpha-check')}\n` }, SINCE - 1);
    assert.deepEqual(await readSkillUse(source, PROJECTS, SINCE), { used: new Set(), transcripts: 0, bytes: 0 });
    assert.equal(source.bytesRead, 0);
  });
});
