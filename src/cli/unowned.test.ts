import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextFinding } from '../doctor/doctor.ts';
import type { SkillFlag } from '../skills/lint.ts';
import { splitUnowned, UNOWNED_NOTICE_CHARS, unownedHeading, unownedNotice, unownedRow, type UnownedWarning } from './unowned.ts';

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
