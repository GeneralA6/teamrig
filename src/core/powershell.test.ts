import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { powerShellRequest } from './powershell.ts';

describe('powerShellRequest', () => {
  it('runs Windows PowerShell with no profile and no prompts', () => {
    const request = powerShellRequest('Get-Date');
    assert.equal(request.program, 'powershell.exe');
    assert.deepEqual(request.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(request.args.length, 4);
  });

  it('carries the script as UTF-16LE base64, quotes and all characters intact', () => {
    const script = `Write-Output 'it''s "quoted"' # café\n$x = 1`;
    const encoded = powerShellRequest(script).args[3] ?? '';
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
  });
});
