import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactLine, promptLine, replyLine, resultsLine, summaryLine, transcript, type FixtureResult, type FixtureTool } from '../testing/transcript-lines.ts';
import { droppedEditReason, droppedEditsOf, skillOf } from './dropped-edit.ts';

const AT = '2030-01-08T10:00:00.000Z';
const SKILL = 'C:\\Users\\you\\.claude\\skills\\alpha-ship\\SKILL.md';
const NOT_FOUND = '<tool_use_error>String to replace not found in file.\nString: Last verified: 2030-01-08 (T12: the build passed</tool_use_error>';
const CHANGED = '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>';

let next = 0;

/** One call of `tool` and its result, as a helper's (sidechain) or the session's lines. */
function step(tool: FixtureTool, result: Omit<FixtureResult, 'id'>, sidechain = true): string[] {
  next += 1;
  const reply = replyLine({ id: `m${next}`, requestId: `r${next}`, at: AT, sidechain, usage: { cacheRead: 1000 }, tools: [tool] });
  return [reply, resultsLine(AT, [{ id: tool.id, ...result }], sidechain)];
}

function edit(id: string, path = SKILL, name = 'Edit'): FixtureTool {
  return { id, name, path };
}

describe('droppedEditsOf', () => {
  it('finds the edit a stale read lost: the anchor another writer changed is not found, and the helper hands back', () => {
    // The second writer read the skill, a parallel run then rewrote its Last verified line, and the
    // second's edit anchored on the old line text was refused; the helper handed back without redoing it.
    const lines = [
      promptLine(AT, 'ship T13', true),
      ...step({ id: 'read', name: 'Read', path: SKILL }, { text: 'Last verified: 2030-01-08 (T12: the build passed)' }),
      ...step(edit('trap'), { text: NOT_FOUND, isError: true }),
      replyLine({ id: 'm-end', requestId: 'r-end', at: AT, sidechain: true, usage: { cacheRead: 1000 } }),
    ];
    assert.deepEqual(droppedEditsOf(transcript(lines), false, 'helper'), [{ skill: 'alpha-ship', path: SKILL, error: 'String to replace not found in file.' }]);
  });

  it('counts an edit of the same file that went through later as redone, however the path is spelled', () => {
    const redone = [promptLine(AT, 'go', true), ...step(edit('a'), { text: CHANGED, isError: true }), ...step(edit('b', SKILL.replaceAll('\\', '/').toLowerCase()), { text: 'ok' })];
    assert.deepEqual(droppedEditsOf(transcript(redone), false, 'helper'), []);
    const other = [promptLine(AT, 'go', true), ...step(edit('a'), { text: CHANGED, isError: true }), ...step(edit('b', '/home/you/.claude/skills/beta-x/SKILL.md'), { text: 'ok' })];
    assert.deepEqual(
      droppedEditsOf(transcript(other), false, 'helper').map((dropped) => dropped.error),
      ['File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'],
    );
  });

  it('reads Write and MultiEdit too, and leaves files outside a skill folder and other tools alone', () => {
    const lines = [
      promptLine(AT, 'go', true),
      ...step(edit('w', '/home/you/.claude/skills/beta-sync/notes.md', 'Write'), { text: CHANGED, isError: true }),
      ...step(edit('m', '/repo/.claude/skills/web-deploy/SKILL.md', 'MultiEdit'), { text: NOT_FOUND, isError: true }),
      ...step(edit('code', '/repo/src/skills/lint.ts'), { text: NOT_FOUND, isError: true }),
      ...step({ id: 'sh', name: 'Bash', command: "sed -i 's/a/b/' /home/you/.claude/skills/beta-sync/SKILL.md" }, { text: 'exit 1', isError: true }),
    ];
    assert.deepEqual(
      droppedEditsOf(transcript(lines), false, 'helper').map((dropped) => dropped.skill),
      ['beta-sync', 'web-deploy'],
    );
  });

  it('starts over at each prompt, so a later turn does not repeat an old refusal', () => {
    const lines = [promptLine(AT, 'go', true), ...step(edit('a'), { text: CHANGED, isError: true }), promptLine(AT, 'next', true), ...step({ id: 'r', name: 'Read', path: SKILL }, { text: 'x', isError: true })];
    assert.deepEqual(droppedEditsOf(transcript(lines), false, 'helper'), []);
  });

  it('keeps a refusal across a compaction, which resumes the same turn without it in context', () => {
    const lines = [promptLine(AT, 'go', true), ...step(edit('a'), { text: CHANGED, isError: true }), compactLine(AT), summaryLine(AT, true)];
    assert.deepEqual(droppedEditsOf(transcript(lines), false, 'helper').map((dropped) => dropped.skill), ['alpha-ship']);
  });

  it("counts only the asked thread's calls: the session's own, or the helper's", () => {
    const helper = [promptLine(AT, 'go', true), ...step(edit('a'), { text: CHANGED, isError: true }, true)];
    assert.deepEqual(droppedEditsOf(transcript(helper), false, 'main'), []);
    const main = [promptLine(AT), ...step(edit('b'), { text: CHANGED, isError: true }, false)];
    assert.equal(droppedEditsOf(transcript(main), false, 'main').length, 1);
    assert.deepEqual(droppedEditsOf(transcript(main), false, 'helper'), []);
  });

  it('skips the first line of a cut tail, and a tail without an error result', () => {
    // The tail starts at the edit's call, which a cut tail drops as a possibly torn line.
    assert.deepEqual(droppedEditsOf(transcript(step(edit('a'), { text: CHANGED, isError: true }, false)), true, 'main'), []);
    assert.deepEqual(droppedEditsOf(transcript([promptLine(AT), ...step(edit('b'), { text: 'ok' }, false)]), false, 'main'), []);
  });

  it('keeps the first line of a long refusal short', () => {
    const lines = [promptLine(AT, 'go', true), ...step(edit('a'), { text: 'x'.repeat(400), isError: true })];
    const [dropped] = droppedEditsOf(transcript(lines), false, 'helper');
    assert.equal(dropped?.error.length, 160);
    assert.ok(dropped?.error.endsWith('...'));
  });
});

describe('skillOf', () => {
  it("names the skill of a file in a user's or a project's skill folder, from either slash", () => {
    assert.equal(skillOf(SKILL), 'alpha-ship');
    assert.equal(skillOf('/repo/.claude/skills/web-deploy/run.ts'), 'web-deploy');
    assert.equal(skillOf('.claude/skills/web-deploy/SKILL.md'), 'web-deploy');
    assert.equal(skillOf('/repo/.claude/skills/web-deploy'), undefined);
    assert.equal(skillOf('/repo/plugins/kit/skills/kit-guide/SKILL.md'), undefined);
  });
});

describe('droppedEditReason', () => {
  it('names each dropped edit and asks to redo it on the current text or say why not', () => {
    const one = { skill: 'alpha-ship', path: SKILL, error: 'String to replace not found in file.' };
    assert.equal(
      droppedEditReason([one], 'kit'),
      `kit: a skill edit was refused and never redone, so the file lacks it: alpha-ship (${SKILL}: String to replace not found in file.).` +
        ' Another session may have changed the file since you read it: read it again and redo the change on its current text, or say why you dropped it.',
    );
    assert.match(droppedEditReason([one, { ...one, skill: 'beta-sync' }], 'kit'), /^kit: 2 skill edits were refused and never redone, so the files lack them: alpha-ship \(.*\); beta-sync \(/);
  });
});
