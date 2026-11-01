import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { powerShellOutput } from './powershell-output.ts';

describe('powerShellOutput', () => {
  it('is what the run printed when it exited 0', () => {
    assert.equal(powerShellOutput({ end: { kind: 'exited', code: 0 }, stdout: 'aGk=\r\n', stderr: 'a warning' }), 'aGk=\r\n');
  });

  it('throws with the end and the first line printed, the error stream first', () => {
    assert.throws(
      () => powerShellOutput({ end: { kind: 'exited', code: 1 }, stdout: 'partial', stderr: '\r\n  Access is denied.  \r\nAt line:4' }),
      /^Error: PowerShell ended with exit 1: Access is denied\.$/,
    );
    assert.throws(() => powerShellOutput({ end: { kind: 'exited', code: 2 }, stdout: 'partial', stderr: '' }), /PowerShell ended with exit 2: partial$/);
    assert.throws(() => powerShellOutput({ end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' }), /PowerShell ended with signal SIGTERM: no error text$/);
  });
});
