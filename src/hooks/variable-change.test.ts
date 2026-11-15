import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { changesVariable } from './variable-change.ts';

const CONTEXT = { cwd: resolve('/', 'work'), home: resolve('/', 'u') };

function changes(command: string, dialect: ShellDialect, name = 'CLAUDECODE'): boolean {
  return changesVariable(runsOf(command, { ...CONTEXT, dialect }), name);
}

describe('changesVariable', () => {
  it('sees a bash assignment, removal or empty environment, on the line or before a command', () => {
    for (const command of [
      'CLAUDECODE= teamrig start',
      'CLAUDECODE=',
      'env -u CLAUDECODE teamrig start',
      'env -uCLAUDECODE teamrig start',
      'env --unset=CLAUDECODE teamrig start',
      'env -i PATH=/bin teamrig start',
      'env CLAUDECODE= teamrig start',
      'unset CLAUDECODE; teamrig start',
      'unset -v CLAUDECODE',
      'export CLAUDECODE=',
      'export -n CLAUDECODE',
      'declare +x CLAUDECODE',
      'declare -x CLAUDECODE=0',
      'local CLAUDECODE',
      'read CLAUDECODE < /dev/null',
      'printf -v CLAUDECODE ""',
      'claudecode= teamrig start',
      'bash -c "CLAUDECODE= teamrig start"',
    ]) {
      assert.equal(changes(command, 'bash'), true, command);
    }
  });

  it('sees PowerShell setting the variable or removing its env drive item', () => {
    for (const command of [
      "$env:CLAUDECODE = ''",
      '$env:CLAUDECODE=$null',
      "${env:CLAUDECODE} = ''",
      "[string]$env:claudecode = ''",
      "if ($true) { $env:CLAUDECODE = '' }",
      'Remove-Item Env:CLAUDECODE',
      'Remove-Item -Path Env:\\CLAUDECODE',
      'ri env:/CLAUDECODE',
      'Remove-Item Env:CLAUDE*',
      "Set-Item Env:CLAUDECODE ''",
      "[Environment]::SetEnvironmentVariable('CLAUDECODE', $null, 'Process')",
    ]) {
      assert.equal(changes(command, 'powershell'), true, command);
    }
  });

  it("sees cmd's set", () => {
    assert.equal(changes('set CLAUDECODE=', 'cmd'), true);
    assert.equal(changes('cmd /c "set CLAUDECODE= && teamrig start"', 'cmd'), true);
  });

  it('passes a line that only reads or mentions the variable, or changes another', () => {
    for (const [command, dialect] of [
      ['grep CLAUDECODE notes.md', 'bash'],
      ['echo "$CLAUDECODE"', 'bash'],
      ['env | grep CLAUDECODE', 'bash'],
      ['unset OTHER', 'bash'],
      ['export OTHER=1 CLAUDECODE_NOTE=x', 'bash'],
      ['TEAMRIG_TEAM=teamrig teamrig list', 'bash'],
      ['Write-Output $env:CLAUDECODE', 'powershell'],
      ['$x = 1', 'powershell'],
      ['Remove-Item ./CLAUDECODE.txt', 'powershell'],
      ['set', 'cmd'],
    ] as const) {
      assert.equal(changes(command, dialect), false, command);
    }
  });

  it('matches the name it is given, in any case', () => {
    assert.equal(changes('TEAMRIG_SESSION=bravo teamrig start', 'bash', 'TEAMRIG_SESSION'), true);
    assert.equal(changes("$env:teamrig_session = 'bravo'", 'powershell', 'TEAMRIG_SESSION'), true);
    assert.equal(changes('TEAMRIG_SESSION=bravo teamrig start', 'bash'), false);
  });
});
