import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handStepKindOf, parseAuditPin, sha256Hex, withAudit, type HandStepAudit } from './hand-step.ts';

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
