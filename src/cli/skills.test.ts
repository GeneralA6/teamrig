import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EXIT } from './runtime.ts';
import { CLAUDE_SESSION, CliHarness, SKILLS_DIR, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine, transcript } from '../testing/transcript-lines.ts';

const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const STATE = join(TEAM_HOME, 'state', 'skills-scorecard.json');
const AT = Date.parse('2030-01-08T09:00:00Z');

function skillText(name: string, signature: string): string {
  return `---\nname: ${name}\ndescription: Use when the inbox has news.\n---\nOwner: alpha\nLast verified: 2030-01-05\n${signature}\n`;
}

async function kitWithSkills(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.files.write(join(SKILLS_DIR, 'alpha-inbox', 'SKILL.md'), skillText('alpha-inbox', 'Signature: `teamrig inbox read`'));
  await kit.files.write(join(SKILLS_DIR, 'alpha-ship', 'SKILL.md'), skillText('alpha-ship', ''));
  return kit;
}

function transcripts(): MemoryTranscripts {
  const source = new MemoryTranscripts();
  const lines = [
    promptLine('2030-01-08T08:00:00Z'),
    replyLine({ id: 'm1', at: '2030-01-08T08:01:00Z', usage: { input: 1 }, tools: [{ id: 't1', name: 'Bash', command: 'teamrig inbox read' }] }),
    promptLine('2030-01-08T08:02:00Z'),
    replyLine({ id: 'm2', at: '2030-01-08T08:03:00Z', usage: { input: 1 }, tools: [{ id: 't2', name: 'Skill', skill: 'alpha-ship' }] }),
    replyLine({ id: 'm3', at: '2030-01-08T08:04:00Z', usage: { input: 1 }, tools: [{ id: 't3', name: 'Bash', command: 'git push' }] }),
    promptLine('2030-01-08T08:05:00Z'),
  ];
  source.set(join(PROJECT, `${CLAUDE_SESSION}.jsonl`), transcript(lines), AT);
  return source;
}

describe('teamrig skills scorecard', () => {
  it("prints each installed skill's loads, missed uses and calls per run over the last week, and saves its reading", async () => {
    const kit = await kitWithSkills();
    const result = await kit.run(['skills', 'scorecard'], { transcripts: transcripts() });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.equal(result.stdout[0], 'Skills scorecard 2030-01-02 to 2030-01-08, baseline 2029-12-26 to 2030-01-01');
    assert.deepEqual(
      result.stdout.filter((line) => line.startsWith('| alpha-')),
      [
        '| alpha-inbox | 0 | 1 | - | - | - | - | 0 | 0 | 2030-01-05 | 6 | not loaded |',
        '| alpha-ship | 1 | 0 | 1.0 | - | 0.0 | - | 0 | 0 | 2030-01-05 | 6 | no signature |',
      ],
    );
    assert.ok(result.stdout.includes('Read 1 files, 0.0 MB this run.'));
    assert.match(kit.files.get(STATE) ?? '', /"since":"2029-12-26"/);
  });

  it('takes the window and baseline from flags, the baseline defaulting to as many days just before', async () => {
    const kit = await kitWithSkills();
    const result = await kit.run(['skills', 'scorecard', '--from', '2030-01-05', '--to', '2030-01-06'], { transcripts: transcripts() });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.equal(result.stdout[0], 'Skills scorecard 2030-01-05 to 2030-01-06, baseline 2030-01-03 to 2030-01-04');
    const explicit = await kit.run(['skills', 'scorecard', '--baseline-from', '2029-12-01', '--baseline-to', '2029-12-02'], { transcripts: transcripts() });
    assert.equal(explicit.stdout[0], 'Skills scorecard 2030-01-02 to 2030-01-08, baseline 2029-12-01 to 2029-12-02');
    assert.ok(explicit.stdout.includes("Days before 2030-01-03 are not counted: the scorecard's first read started there."));
  });

  it('refuses a day that is not a YYYY-MM-DD day, and a range that ends before it starts', async () => {
    const kit = await kitWithSkills();
    const notDay = await kit.run(['skills', 'scorecard', '--to', 'yesterday'], { transcripts: transcripts() });
    assert.equal(notDay.code, EXIT.usage);
    assert.match(notDay.stderr.join('\n'), /--to "yesterday" is not a YYYY-MM-DD day/);
    const backwards = await kit.run(['skills', 'scorecard', '--baseline-from', '2030-01-09'], { transcripts: transcripts() });
    assert.equal(backwards.code, EXIT.usage);
    assert.match(backwards.stderr.join('\n'), /--baseline-from 2030-01-09 is after the range's last day, 2030-01-01/);
  });
});
