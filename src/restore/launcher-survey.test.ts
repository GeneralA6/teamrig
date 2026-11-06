import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SURVEY, sameSurvey, surveyFields, surveyOf, type FoundPart, type LauncherSurvey, type RegisteredPart } from './launcher-survey.ts';

const LOGON: RegisteredPart = { kind: 'logon', where: 'HKCU Run TeamrigSessionRestore', program: 'C:\\nodejs\\node.exe', script: 'D:\\homes\\pat\\.teamrig\\bin\\restore-check.mjs' };
const PIN: RegisteredPart = { kind: 'shortcut', where: 'C:\\TaskBar\\Restore Claude Sessions.lnk', program: 'C:\\nodejs\\node.exe', script: 'D:\\homes\\pat\\.teamrig\\bin\\restore-run.mjs' };
const STRAY: FoundPart = { kind: 'shortcut', where: 'C:\\Desktop\\Restore Claude Sessions.lnk', runs: '"C:\\wt.exe" -w restore (in "")' };
const SURVEY: LauncherSurvey = { registered: [LOGON, PIN], found: [STRAY] };

describe('surveyOf', () => {
  it('reads the registered and found lists of a record', () => {
    assert.deepEqual(surveyOf({ v: 2, registered: [LOGON, PIN], found: [STRAY] }), SURVEY);
    assert.deepEqual(surveyOf({ registered: [], found: [] }), EMPTY_SURVEY);
  });

  it('reads no survey from a record missing a list, or holding a damaged item, so a check flags nothing on it', () => {
    const damaged: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { v: 2, version: '0.283.0' },
      { registered: [LOGON] },
      { found: [STRAY] },
      { registered: 'none', found: [] },
      { registered: [{ ...LOGON, kind: 'service' }], found: [] },
      { registered: [{ ...LOGON, program: 7 }], found: [] },
      { registered: [{ kind: 'logon', where: LOGON.where, program: LOGON.program }], found: [] },
      { registered: [], found: [{ kind: 'shortcut', where: STRAY.where }] },
      { registered: [], found: [STRAY, null] },
    ];
    for (const record of damaged) {
      assert.equal(surveyOf(record), undefined, JSON.stringify(record));
    }
  });
});

describe('surveyFields', () => {
  it('keeps only the fields the record holds, in a fixed order', () => {
    const extra = { registered: [{ ...LOGON, before: 'old' }], found: [{ ...STRAY, path: STRAY.where }] };
    assert.equal(
      JSON.stringify(surveyFields(extra)),
      JSON.stringify({ registered: [{ kind: 'logon', where: LOGON.where, program: LOGON.program, script: LOGON.script }], found: [{ kind: 'shortcut', where: STRAY.where, runs: STRAY.runs }] }),
    );
  });
});

describe('sameSurvey', () => {
  it('holds two surveys of the same parts in the same order equal, whatever else they carry', () => {
    assert.equal(sameSurvey(SURVEY, { registered: [{ ...LOGON }, { ...PIN }], found: [{ ...STRAY }] }), true);
    assert.equal(sameSurvey(EMPTY_SURVEY, { registered: [], found: [] }), true);
  });

  it('tells apart surveys in another order, with a part more, or a part that starts something else', () => {
    assert.equal(sameSurvey(SURVEY, { registered: [PIN, LOGON], found: [STRAY] }), false);
    assert.equal(sameSurvey(SURVEY, { registered: [LOGON, PIN], found: [] }), false);
    assert.equal(sameSurvey(SURVEY, { registered: [LOGON, { ...PIN, program: 'C:\\old\\node.exe' }], found: [STRAY] }), false);
  });
});
