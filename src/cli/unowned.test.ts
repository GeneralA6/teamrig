import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextFinding } from '../doctor/doctor.ts';
import type { SkillFlag } from '../skills/lint.ts';
import { testTask } from '../testing/task.ts';
import { coverUnowned, splitUnowned, UNOWNED_NOTICE_CHARS, unownedHeading, unownedNotice, unownedRow, type UnownedWarning } from './unowned.ts';

const SESSIONS: ReadonlySet<string> = new Set(['lead', 'alpha']);
const LISTS: ContextFinding = { kind: 'context-lists', detail: 'lists in the context of the newest session (a.jsonl): over its budget', budget: 'maxSessionListsChars' };

function skillFlag(skill: string, owner: string | null): SkillFlag {
  return { kind: 'UNVERIFIED', skill, owner, detail: 'no "Last verified: YYYY-MM-DD"' };
}

describe('splitUnowned', () => {
  it('keeps the skill flags a session on the team owns and makes every other flag and every context finding unowned', () => {
    const owned = skillFlag('alpha-deploy', 'alpha');
    const { skills, unowned } = splitUnowned([LISTS], [owned, skillFlag('orphan', null), skillFlag('ghost-sync', 'ghost')], SESSIONS, 'skills-dir');
    assert.deepEqual(skills, [owned]);
    assert.deepEqual(unowned, [
      {
        key: 'context maxSessionListsChars',
        source: 'the context check [contextFiles.maxSessionListsChars]',
        text: 'WARN context-lists lists in the context of the newest session (a.jsonl): over its budget',
        names: ['contextFiles.maxSessionListsChars'],
      },
      { key: 'skill UNVERIFIED orphan', source: 'the skill check of skills-dir', text: 'SKILL UNVERIFIED (no "Last verified: YYYY-MM-DD") - orphan' },
      { key: 'skill UNVERIFIED ghost-sync', source: 'the skill check of skills-dir', text: 'SKILL UNVERIFIED (no "Last verified: YYYY-MM-DD") ghost ghost-sync' },
    ]);
  });

  it('keys a warning by what stands, not by its detail, so a detail that changes keeps its key', () => {
    const today = splitUnowned([], [{ ...skillFlag('orphan', null), detail: 'last verified 2030-01-01, 31 d ago > 30' }], SESSIONS, 'skills-dir');
    const tomorrow = splitUnowned([], [{ ...skillFlag('orphan', null), detail: 'last verified 2030-01-01, 32 d ago > 30' }], SESSIONS, 'skills-dir');
    assert.deepEqual(
      today.unowned.map((warning) => warning.key),
      tomorrow.unowned.map((warning) => warning.key),
    );
    const size = splitUnowned([{ ...LISTS, kind: 'context-size', budget: 'maxClaudeMdChars', detail: 'CLAUDE.md files (a 13,001): over' }], [], SESSIONS, 'skills-dir');
    assert.deepEqual(
      size.unowned.map((warning) => warning.key),
      ['context maxClaudeMdChars'],
    );
  });

  it('makes the wide allow rules one warning from the permissions check, keyed apart from its counts', () => {
    const { unowned } = splitUnowned([{ kind: 'allow-wide', detail: '3 local allow rule(s) in 2 settings file(s) approve a whole tool or program' }], [], SESSIONS, 'skills-dir');
    assert.deepEqual(unowned, [
      {
        key: 'permissions allow-wide',
        source: 'the permissions check [permissions.keepAllow]',
        text: 'WARN allow-wide 3 local allow rule(s) in 2 settings file(s) approve a whole tool or program',
      },
    ]);
  });
});

describe('the unowned lines', () => {
  const warning: UnownedWarning = { key: 'skill OWNER orphan', source: 'the skill check of skills-dir', text: 'SKILL OWNER (no "Owner: <session>" line) - orphan' };

  it('heads them with the lead they go to and names each one by its source', () => {
    assert.equal(unownedHeading(2, 'boss'), 'UNOWNED 2 warning(s) no session owns, so they go to the lead (boss): fix each, hand it on (teamrig add --owner <session>) or settle its check');
    assert.equal(unownedRow(warning), 'from the skill check of skills-dir: SKILL OWNER (no "Owner: <session>" line) - orphan');
  });

  it("tells the lead where the warning came from, its text and what to do, on one line", () => {
    assert.equal(
      unownedNotice(warning),
      'the skill check of skills-dir raised a warning no session owns, so it is yours as lead: SKILL OWNER (no "Owner: <session>" line) - orphan; ' +
        'fix it, hand it on (teamrig add --owner <session>) or settle the check (teamrig check --all prints it in full)',
    );
  });

  it('keeps the inbox line one line and cuts a long text to UNOWNED_NOTICE_CHARS', () => {
    const notice = unownedNotice({ ...warning, text: `first\nsecond  ${'x'.repeat(UNOWNED_NOTICE_CHARS)}` });
    assert.doesNotMatch(notice, /[\r\n]/);
    const text = /yours as lead: (.*); fix it/.exec(notice)?.[1] ?? '';
    assert.equal(text.length, UNOWNED_NOTICE_CHARS);
    assert.match(text, /^first second x+\.\.\.$/);
  });
});

describe('coverUnowned (#814)', () => {
  const memory: UnownedWarning = { key: 'context maxMemoryIndexChars', source: 'the context check', text: 'WARN context-size memory index', names: ['contextFiles.maxMemoryIndexChars', '/m/MEMORY.md'] };
  const nameless: UnownedWarning = { key: 'idle-pass failed', source: 'the idle pass check', text: 'FLEET-STALE' };

  it('covers a warning by the first open task naming its file or config key, and leaves one with no names unowned', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'done', title: 'Trim /m/MEMORY.md' }),
      testTask({ id: 'T2', status: 'dropped', title: 'Trim /m/MEMORY.md' }),
      testTask({ id: 'T3', status: 'waiting', owner: 'bravo', title: 'Memory', description: 'raise contextFiles.maxMemoryIndexChars' }),
      testTask({ id: 'T4', status: 'open', title: 'Trim /m/MEMORY.md' }),
    ];
    const { unowned, covered } = coverUnowned([memory, nameless], tasks, '/h/u');
    assert.deepEqual(unowned, [nameless]);
    assert.deepEqual(covered.map(({ warning, task }) => [warning.key, task.id, task.owner]), [['context maxMemoryIndexChars', 'T3', 'bravo']]);
  });

  it('covers nothing with only done or dropped tasks', () => {
    const tasks = [testTask({ id: 'T1', status: 'done', title: 'Trim /m/MEMORY.md' }), testTask({ id: 'T2', status: 'dropped', title: 'Trim /m/MEMORY.md' })];
    assert.deepEqual(coverUnowned([memory], tasks, '/h/u'), { unowned: [memory], covered: [] });
  });

  it('covers a warning on a total across files only by its config key, never by a task naming one of the files', () => {
    const total = (budget: 'maxClaudeMdChars' | 'maxSkillListingChars', paths: string[]): UnownedWarning =>
      splitUnowned([{ kind: 'context-size', detail: 'over', budget, paths }], [], SESSIONS, 'skills-dir').unowned[0]!;
    const claudeMd = total('maxClaudeMdChars', ['/p/CLAUDE.md', '/h/u/.claude/CLAUDE.md']);
    const listing = total('maxSkillListingChars', ['/s/alpha-deploy', '/s/bravo-sync']);
    const byFile = [testTask({ id: 'T6', status: 'open', title: 'Add a rule to /p/CLAUDE.md' }), testTask({ id: 'T7', status: 'open', title: 'Fix /s/alpha-deploy' })];
    assert.deepEqual(coverUnowned([claudeMd, listing], byFile, '/h/u'), { unowned: [claudeMd, listing], covered: [] });
    const byKey = [testTask({ id: 'T8', status: 'open', title: 'Trim skills', description: 'under contextFiles.maxSkillListingChars' })];
    assert.deepEqual(
      coverUnowned([claudeMd, listing], byKey, '/h/u').covered.map(({ warning, task }) => [warning.key, task.id]),
      [['context maxSkillListingChars', 'T8']],
    );
    const memory = splitUnowned([{ kind: 'context-size', detail: 'over', budget: 'maxMemoryIndexChars', paths: ['/m/MEMORY.md'] }], [], SESSIONS, 'skills-dir').unowned[0]!;
    assert.deepEqual(memory.names, ['contextFiles.maxMemoryIndexChars', '/m/MEMORY.md']);
  });

  it('covers a warning on a file under the home folder by a task naming it as ~/...', () => {
    const home: UnownedWarning = { ...memory, names: ['/h/u/.claude/MEMORY.md'] };
    const { covered } = coverUnowned([home], [testTask({ id: 'T5', status: 'open', title: 'Trim ~/.claude/MEMORY.md' })], '/h/u');
    assert.deepEqual(covered.map(({ task }) => task.id), ['T5']);
  });
});
