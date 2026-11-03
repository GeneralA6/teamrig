import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SecretScanner } from '../core/secrets.ts';
import { KeepList } from './allow-rules.ts';
import { planLine, totalLine, wideAllowText, writeLine } from './report.ts';
import type { SettingsFile } from './settings-scope.ts';
import { planFile, rewritesOf, type FilePlan } from './trim.ts';

/** A value a rule can hold; no line may carry it. Joined, so no source line holds a URL the secret redactor catches. */
const HELD_VALUE = ['postgres://user:', 'hunter22', '@db.example.net'].join('');
const KEEP = new KeepList(['Bash(kubectl get *)', 'WebSearch']);
const SECRETS = new SecretScanner();
const SHARED: SettingsFile = { path: join('/repo', '.claude', 'settings.json'), kind: 'shared' };
const LOCAL: SettingsFile = { path: join('/repo', '.claude', 'settings.local.json'), kind: 'local' };
const ALLOW = ['Bash(kubectl get:*)', 'Bash(node:*)', `Bash(psql ${HELD_VALUE})`, 'Read', 'WebSearch'];

function plan(file: SettingsFile, allow: readonly string[]): FilePlan {
  return planFile(file, JSON.stringify({ permissions: { allow } }), KEEP, 'wide', SECRETS);
}

function assertNoSecret(lines: readonly (string | undefined)[]): void {
  for (const line of lines) {
    assert.ok(!(line ?? '').includes('hunter22'), line);
  }
}

describe('planLine', () => {
  it('tells what a rewrite removes and keeps, by class', () => {
    const line = planLine(plan(LOCAL, [...ALLOW, 'Bash(git log)']));
    assert.equal(line, `  ${LOCAL.path}: 6 allow rules -> 3, remove 3 (Bash credential 1, Bash wide 1, Read wide 1); keeps 2 on the keep-list, 1 more (Bash exact 1)`);
    assertNoSecret([line]);
  });

  it('tells a shared file is changed by a commit, and a file with nothing to remove', () => {
    assert.equal(planLine(plan(SHARED, ALLOW)), `  ${SHARED.path}: 5 allow rules, 3 to remove (Bash credential 1, Bash wide 1, Read wide 1); it is committed with its repo, so change it by a commit`);
    assert.equal(planLine(plan(LOCAL, ['WebSearch'])), `  ${LOCAL.path}: 1 allow rules, none to remove; keeps 1 on the keep-list`);
  });

  it('says nothing of a missing file or one with no allow rule, and why it leaves an unreadable one', () => {
    assert.equal(planLine(planFile(LOCAL, undefined, KEEP, 'wide', SECRETS)), undefined);
    assert.equal(planLine(plan(LOCAL, [])), undefined);
    const unreadable = planLine(planFile(LOCAL, `{"x": "${HELD_VALUE}"`, KEEP, 'wide', SECRETS));
    assert.equal(unreadable, `  ${LOCAL.path}: left as it is, not a JSON object`);
  });
});

describe('totalLine and writeLine', () => {
  it('adds up the files a trim rewrites, not the shared ones', () => {
    const plans = [plan(LOCAL, ALLOW), plan(SHARED, ALLOW), plan({ path: join('/u', 'settings.json'), kind: 'user' }, ['Read', 'Edit'])];
    const line = totalLine(plans);
    assert.equal(line, 'TOTAL 2 file(s) to rewrite: 7 allow rules -> 2 (remove 5: Read wide 2, Bash credential 1, Bash wide 1, Edit wide 1)');
    assert.equal(totalLine([]), 'TOTAL 0 file(s) to rewrite: 0 allow rules -> 0 (remove 0: )');
  });

  it('tells how each rewrite went', () => {
    const [rewrite] = rewritesOf([plan(LOCAL, ALLOW)]);
    assert.ok(rewrite !== undefined);
    const backup = join('/state', '01-settings.local.json');
    const lines = [
      writeLine({ plan: rewrite, backup, result: 'wrote' }),
      writeLine({ plan: rewrite, backup, result: 'changed-since-read' }),
      writeLine({ plan: rewrite, backup, result: 'not-verified' }),
    ];
    assert.deepEqual(lines, [
      `  ${LOCAL.path}: 5 allow rules -> 2, removed Bash credential 1, Bash wide 1, Read wide 1`,
      `  ${LOCAL.path}: changed since it was read, so left as it is; run the trim again`,
      `  ${LOCAL.path}: FAILED the read-back check after the write; its old text is at ${backup}`,
    ]);
    assertNoSecret(lines);
  });
});

describe('wideAllowText', () => {
  it('flags the rules that approve a whole tool or program or hold a credential, and is quiet without any', () => {
    assert.equal(wideAllowText({ files: 0, counts: [] }), undefined);
    assert.equal(
      wideAllowText({ files: 2, counts: [['Bash wide', 3], ['Bash credential', 1]] }),
      "4 local allow rule(s) in 2 settings file(s) approve a whole tool or program, so auto mode's classifier never sees those calls, or hold a credential saved with an approved command (Bash wide 3, Bash credential 1); `teamrig permissions trim` previews their removal, and the owner runs it with --yes",
    );
  });
});
