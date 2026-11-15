import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handStepLintReason, handStepsOf } from './hand-step-lint.ts';

const FENCE = '```';
const block = (lang: string, body: string): string => `${FENCE}${lang}\n${body}\n${FENCE}`;
const CALL = "& 'C:\\Work\\app\\tasks\\T7\\fix.ps1'";

describe('handStepsOf', () => {
  it('finds the shell and JSON fences a human would run or paste, each shape once, in reply order', () => {
    const reply = ['Run this:', block('json', '{ "permissions": { "allow": ["Bash(git push:*)"] } }'), 'then', block('bash', 'rm -rf build'), block('powershell', 'Remove-Item x')].join('\n');
    assert.deepEqual(handStepsOf(reply), ['json', 'shell']);
    for (const lang of ['sh', 'shell', 'zsh', 'console', 'ps1', 'pwsh', 'ps', 'cmd', 'bat', 'batch', 'PowerShell']) {
      assert.deepEqual(handStepsOf(block(lang, 'x')), ['shell'], lang);
    }
    assert.deepEqual(handStepsOf(block('jsonc', '{}')), ['json']);
  });

  it('finds a call line in a fence with no language or in the reply text, and not inside another fence', () => {
    assert.deepEqual(handStepsOf(`Please run:\n${block('', CALL)}`), ['call']);
    assert.deepEqual(handStepsOf(`Please run:\n  ${CALL}\nand send me the last line.`), ['call']);
    assert.deepEqual(handStepsOf(`${block('bash', CALL)}`), ['shell']);
  });

  it('leaves code the human does not run, a fence with no language and no call line, and an & inside a sentence', () => {
    assert.deepEqual(handStepsOf(block('ts', 'const x = 1;')), []);
    assert.deepEqual(handStepsOf(block('', 'ok 12 - passes')), []);
    assert.deepEqual(handStepsOf("Tom & 'Jerry' ran it."), []);
    assert.deepEqual(handStepsOf('No code here.'), []);
  });

  it('lets a block or line by that the line before it, or its own line, marks read-only', () => {
    assert.deepEqual(handStepsOf(`Read-only check:\n\n${block('bash', 'claude --debug')}`), []);
    assert.deepEqual(handStepsOf(`${CALL}   # read-only`), []);
    assert.deepEqual(handStepsOf(`Read-only check:\n${block('bash', 'git status')}\nNow the fix:\n${block('bash', 'git push')}`), ['shell']);
  });
});

describe('handStepLintReason', () => {
  it('names each shape the reply hands the human with no sha256 and the rule it breaks', () => {
    const reason = handStepLintReason(`Paste:\n${block('json', '{ "a": 1 }')}\nthen\n${CALL}`, 'teamrig');
    assert.equal(
      reason,
      "teamrig: your reply handed the human a JSON block, a PowerShell call line (& '...') with no pinned sha256. Core rule 11: a step the human runs by" +
        ' hand that changes anything or touches a secret reaches them only as a file the security reviewer audited, run by' +
        ' one line with its sha256 (skill hand-step). If it is such a step, tell the human now not to run it from chat,' +
        ' and hand it as an audited file. If it only reads (changes nothing, touches no secret), say so in one line;' +
        ' write read-only on the line before such a block next time.',
    );
  });

  it("passes a reply that pins the file: the card's run line, show's audit line or a whole sha256", () => {
    assert.equal(handStepLintReason(`run: ${CALL}   (sha256 7a0d9294, audited by security)`, 'teamrig'), undefined);
    assert.equal(handStepLintReason(`${block('', CALL)}\naudit: C:\\Work\\app\\tasks\\T7\\fix.ps1   (sha256 fb67c8b7, audited by security at 10:00)`, 'teamrig'), undefined);
    assert.equal(handStepLintReason(`${block('powershell', CALL)}\nIts SHA256: ${'ab'.repeat(32)}`, 'teamrig'), undefined);
  });

  it('flags a call line whose only fingerprint is a backticked short hex, which a commit id would match too', () => {
    assert.notEqual(handStepLintReason(`${CALL}\nfingerprint \`25024f78\``, 'teamrig'), undefined);
  });

  it('says nothing for a reply with no hand step', () => {
    assert.equal(handStepLintReason(`Done: ${block('ts', 'x()')} sha-free.`, 'teamrig'), undefined);
  });
});
