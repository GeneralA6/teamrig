import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { bareFindings, envFindings, environmentReads, printedNames } from './env.ts';
import { describeFinding } from './findings.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';

const names = new SecretNames(DEFAULT_SECRET_ENV_NAMES);

/** What the line's programs and bare commands print from the environment, each one's output taken as printed. */
function printed(command: string, dialect: ShellDialect = 'bash'): string[] {
  const runs = runsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect });
  return [...runs.programs.flatMap((run) => envFindings(run, names)), ...runs.bare.flatMap((bare) => bareFindings(bare, names))].map(describeFinding);
}

describe('printedNames', () => {
  it('reads the bash variables whose value a word prints, not a length, a set test or an indirection', () => {
    assert.deepEqual(printedNames('$A ${B} ${C:-x} ${D:0:4} ${#E} ${F:+y} ${!G}', 'bash'), ['A', 'B', 'C', 'D']);
  });

  it('reads PowerShell references but their length, and cmd references with a part', () => {
    assert.deepEqual(printedNames('$env:A ${env:B} $env:C.Length', 'powershell'), ['A', 'B']);
    assert.deepEqual(printedNames('%A% %B:~0,4%', 'cmd'), ['A', 'B']);
  });
});

describe('envFindings and bareFindings', () => {
  it('reads bash dumps of the environment and the secret variables a call prints', () => {
    assert.deepEqual(printed('printenv; env; set; export -p; declare'), Array(5).fill('the whole environment'));
    assert.deepEqual(printed('printenv GITHUB_TOKEN HOME; declare -p NPM_TOKEN PATH'), ['the value of $GITHUB_TOKEN', 'the value of $NPM_TOKEN']);
    assert.deepEqual(printed('echo "$GITHUB_TOKEN" ${#NPM_TOKEN} ${NPM_TOKEN:+set} $HOME; cat <<< "$API_KEY"'), [
      'the value of $GITHUB_TOKEN',
      'the value of $API_KEY',
    ]);
  });

  it('lets bash calls that print no value pass', () => {
    assert.deepEqual(printed('set -e; export X=1; declare -f; declare -x Y=2; env -i; echo $HOME; cat <<< "$HOME"'), []);
  });

  it('reads the PowerShell env: drive, its references and the environment dump', () => {
    assert.deepEqual(printed('gci env:; Get-Item env:GITHUB_TOKEN; ls env:PATH; gc env:/N*', 'powershell'), [
      'the whole environment',
      'the value of $GITHUB_TOKEN',
      'the whole environment',
    ]);
    assert.deepEqual(printed('$env:GITHUB_TOKEN; Write-Output $env:NPM_TOKEN; [Environment]::GetEnvironmentVariables()', 'powershell'), [
      'the value of $NPM_TOKEN',
      'the value of $GITHUB_TOKEN',
      'the whole environment',
    ]);
  });

  it('lets a PowerShell length, assignment, comparison or condition pass', () => {
    assert.deepEqual(printed('$env:GH_TOKEN.Length; $t = $env:API_KEY; $env:API_KEY -eq ""; $env:API_KEY += "x"', 'powershell'), []);
  });

  it("reads cmd's set and echo", () => {
    assert.deepEqual(printed('cmd /c "set & set GIT & echo %GITHUB_TOKEN%"'), ['the value of $GITHUB_TOKEN', 'the whole environment', 'the whole environment']);
    assert.deepEqual(printed('cmd /c "set X=1 & set /a 1+1"'), []);
  });
});

describe('environmentReads', () => {
  it('reads a GetEnvironmentVariable call of a secret name outside an assignment', () => {
    const line = "[Environment]::GetEnvironmentVariable('GITHUB_TOKEN'); $x = [System.Environment]::GetEnvironmentVariable(\"NPM_TOKEN\"); [Environment]::GetEnvironmentVariable('HOME')";
    assert.deepEqual(environmentReads(line, names).map(describeFinding), ['the value of $GITHUB_TOKEN']);
  });
});
