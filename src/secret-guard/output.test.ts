import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { quiet } from './output.ts';

/** The programs of the line whose output reaches the screen. */
function loud(command: string, dialect: ShellDialect = 'bash'): string[] {
  return runsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect })
    .programs.filter((run) => !quiet(run))
    .map((run) => run.name);
}

/** The commands of the line that start no program and whose value reaches the screen. */
function loudBare(command: string): string[] {
  return runsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect: 'powershell' })
    .bare.filter((bare) => !quiet(bare))
    .map((bare) => bare.words.map((word) => word.text).join(' '));
}

describe('quiet', () => {
  it('takes a redirection of stdout to a file as quiet, and one back to the screen as printed', () => {
    assert.deepEqual(loud('cat a > out.txt; cat b &>> log; cat c > /dev/stderr; cat d > f 1>&2; cat e 2> err'), ['cat', 'cat', 'cat']);
  });

  it('takes a pipe into a program that passes it on unprinted as quiet', () => {
    assert.deepEqual(loud('cat t | wc -c; cat t | docker login --password-stdin; cat t | gh secret set X; cat t | sha256sum'), [
      'wc',
      'docker',
      'gh',
      'sha256sum',
    ]);
    assert.deepEqual(loud('cat t | sort | head -1'), ['cat', 'sort', 'head']);
    assert.deepEqual(loud('cat t | grep -q x'), []);
  });

  it('takes a search or edit that prints no content as quiet', () => {
    assert.deepEqual(loud('grep -q T a; grep -c T a; egrep -il T a; rg --files-with-matches T; sed -i s/a/b/ a; perl -pi -e 1 a; grep T a'), ['grep']);
    assert.deepEqual(loud('Select-String T a -Quiet; Select-String T a', 'powershell'), ['select-string']);
  });

  it('takes the output a PowerShell assignment takes as quiet', () => {
    assert.deepEqual(loud('$x = Get-Content a; Get-Content b', 'powershell'), ['get-content']);
  });

  it('takes a substitution as printed only when the command holding it prints the value', () => {
    assert.deepEqual(loud('curl -H "A: $(cat t)" u'), ['curl']);
    assert.deepEqual(loud('echo "$(cat t)"'), ['cat', 'echo']);
    assert.deepEqual(loud('echo "$(cat t)" > f'), []);
    assert.deepEqual(loud('X=$(cat t); cat "$(cat list)"'), ['cat', 'cat']);
    assert.deepEqual(loud(`node -e "console.log('$(cat t)')"; node -e "fetch('$(cat t)')"`), ['cat', 'node', 'node']);
    assert.deepEqual(loud('$X $(cat t)'), ['cat']);
  });

  it('reads PowerShell groups the same way', () => {
    assert.deepEqual(loud('Write-Output (Get-Content a); $v = (Get-Content b); Invoke-RestMethod -Uri (Get-Content c)', 'powershell'), [
      'get-content',
      'write-output',
      'invoke-restmethod',
    ]);
    assert.deepEqual(loudBare('$env:A; if ($env:B) { 1 }; Write-Output ($env:C); [string]::IsNullOrEmpty($env:D)'), [
      '$env:A',
      'if',
      '$env:C',
      '[string]::IsNullOrEmpty ($env:D)',
    ]);
  });
});
