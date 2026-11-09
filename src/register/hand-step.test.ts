import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditOf, handStepFileProblem, handStepKindOf, handStepShapeOf, parseAuditPin, runLineOf, sha256Hex, shortSha256, withAudit, type HandStepAudit } from './hand-step.ts';

describe('handStepShapeOf', () => {
  it('names code typed for the human: a backticked span, the call operator, a write cmdlet, a JSON object', () => {
    assert.equal(handStepShapeOf('run `git config core.hooksPath x` once'), 'a backticked span');
    assert.equal(handStepShapeOf("then & 'C:/steps/grant.ps1' in PowerShell"), "PowerShell's call operator (& ')");
    assert.equal(handStepShapeOf('then &"C:/steps/grant.ps1"'), "PowerShell's call operator (& ')");
    assert.equal(handStepShapeOf('one add-content line on the profile'), 'a PowerShell write cmdlet');
    assert.equal(handStepShapeOf('Set-ItemProperty on the key, then Remove-Item the old one'), 'a PowerShell write cmdlet');
    assert.equal(handStepShapeOf('add { "prompts": true } to config.json'), 'a JSON object');
  });

  it('names an ask to paste in any form but the past one, which names a paste done', () => {
    assert.deepEqual(
      ['one paste adds the key file to the guard paths', 'Pastes the line', 'after pasting it, restart'].map(handStepShapeOf),
      ['an ask to paste', 'an ask to paste', 'an ask to paste'],
    );
    assert.equal(handStepShapeOf('keep the hand-pasted lines of today'), undefined);
  });

  it('names nothing in plain prose, nor in words that only hold a shape', () => {
    const prose = ['Basic at 9 dollars a month, R&D first', 'the pastebin stays, the item is new', 'Set the content of the plan aside', 'a {braced} note'];
    assert.deepEqual(prose.map(handStepShapeOf), [undefined, undefined, undefined, undefined]);
  });
});

describe('handStepKindOf', () => {
  it('names a PowerShell, bash or steps file by its extension in any case', () => {
    assert.deepEqual(['/w/add-key.ps1', '/w/ADD.PS1', '/w/run.sh', 'C:\\w\\steps.Md'].map(handStepKindOf), ['.ps1', '.ps1', '.sh', '.md']);
  });

  it('names no other file, nor one without an extension', () => {
    assert.deepEqual(['/w/run.mjs', '/w/run.cmd', '/w/run.bat', '/w/run.ps1.txt', '/w/run', '/w/.ps1x'].map(handStepKindOf), [undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('sha256Hex', () => {
  it('hashes the bytes in lowercase hex', () => {
    assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('shortSha256', () => {
  it('shows the first 8 characters of a sha256', () => {
    assert.equal(shortSha256('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), 'ba7816bf');
  });
});

describe('parseAuditPin', () => {
  const sha256 = 'f'.repeat(64);

  it('reads a path and a sha256', () => {
    assert.deepEqual(parseAuditPin({ path: '/w/a.ps1', sha256, extra: 1 }), { path: '/w/a.ps1', sha256 });
  });

  it('refuses a value that is no object, and a pin with a blank or multi-line path or a sha256 not 64 lowercase hex', () => {
    assert.equal(parseAuditPin(['/w/a.ps1', sha256]), 'audit is not an object');
    assert.equal(parseAuditPin(null), 'audit is not an object');
    for (const bad of [{ path: ' ', sha256 }, { path: '/w/a.ps1\r', sha256 }, { path: '/w/a.ps1', sha256: `${sha256}0` }, { path: '/w/a.ps1', sha256: 'g'.repeat(64) }, { sha256 }]) {
      const problem = parseAuditPin(bad);
      assert.ok(typeof problem === 'string' && problem.startsWith('bad audit '), JSON.stringify(bad));
    }
  });
});

describe('withAudit', () => {
  const audit = (path: string, sha256: string, at: string): HandStepAudit => ({ path, sha256, by: 'gamma', at });
  const a = audit('/w/a.ps1', '1'.repeat(64), '2030-01-07T09:00:00.000Z');
  const b = audit('/w/b.sh', '2'.repeat(64), '2030-01-07T10:00:00.000Z');

  it('adds a path not yet audited at the end', () => {
    assert.deepEqual(withAudit([a], b), [a, b]);
  });

  it('replaces the audit of a path audited again, in its place', () => {
    const again = audit('/w/a.ps1', '3'.repeat(64), '2030-01-07T11:00:00.000Z');
    assert.deepEqual(withAudit([a, b], again), [again, b]);
  });
});

describe('handStepFileProblem', () => {
  it('passes a file of a hand step kind and names the kinds to any other', () => {
    assert.equal(handStepFileProblem('/w/add-key.ps1'), undefined);
    assert.equal(handStepFileProblem('/w/run.mjs'), '/w/run.mjs is not a hand step file: only .ps1, .sh, .md files have a run line');
  });
});

describe('runLineOf', () => {
  it('runs a PowerShell file by the call operator, single-quoted, a quote in its path doubled', () => {
    assert.equal(runLineOf('C:\\w\\add key.ps1'), "& 'C:\\w\\add key.ps1'");
    assert.equal(runLineOf("C:\\w\\it's\\add.PS1"), "& 'C:\\w\\it''s\\add.PS1'");
  });

  it('runs a bash file by bash, single-quoted, a quote in its path closed, escaped and opened again', () => {
    assert.equal(runLineOf('/w/grant read.sh'), "bash '/w/grant read.sh'");
    assert.equal(runLineOf("/w/it's/grant.sh"), "bash '/w/it'\\''s/grant.sh'");
  });

  it('says to follow the steps of a steps file, and has no line for a file of no hand step kind', () => {
    assert.equal(runLineOf('/w/steps.md'), 'follow the steps in /w/steps.md');
    assert.equal(runLineOf('/w/run.mjs'), undefined);
  });
});

describe('auditOf', () => {
  const a: HandStepAudit = { path: '/w/a.ps1', sha256: '1'.repeat(64), by: 'gamma', at: '2030-01-07T09:00:00.000Z' };
  const b: HandStepAudit = { path: '/w/b.sh', sha256: '2'.repeat(64), by: 'gamma', at: '2030-01-07T10:00:00.000Z' };

  it('finds the audit a task keeps of a path, and none for a path no audit pins', () => {
    assert.equal(auditOf([a, b], '/w/b.sh'), b);
    assert.equal(auditOf([a, b], '/w/c.ps1'), undefined);
    assert.equal(auditOf([], '/w/a.ps1'), undefined);
  });
});
