import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { powershellLineReads } from './powershell.ts';
import { prefixWords, type ReadonlyRules } from './rules.ts';

const RULES: ReadonlyRules = { prefixes: ['npx tsc --noEmit', 'npx jest'].map(prefixWords), exported: new Set() };

/** Asserts each line reads (`expected` true) or not, naming the line on failure. */
function expectAll(lines: readonly string[], expected: boolean, rules: ReadonlyRules = RULES): void {
  for (const line of lines) {
    assert.equal(powershellLineReads(line, rules), expected, JSON.stringify(line));
  }
}

describe('powershellLineReads', () => {
  it('allows reading cmdlets, pipelines and variables of the line', () => {
    expectAll(
      [
        "$raw = Get-Content C:\\repo\\out.json -Raw; $json = ($raw -split 'STATS:')[1].Trim(); $rows = $json | ConvertFrom-Json; $rows.Count; $rows | Select-Object -First 3 | ConvertTo-Json -Compress",
        'Get-Content file.json -Raw | ConvertFrom-Json',
        'Get-ChildItem C:\\repo -Filter *.ts | Select-Object -First 5',
        "$x = 'literal'; $x.ToUpper()",
        '$rows | Sort-Object name | Format-Table',
        "Get-Content log.txt | Select-String 'error' | Measure-Object",
        'Test-Path C:\\repo\\app',
        "$parts = 'a,b,c'.Split(','); $parts.Count",
        '$rows |\n  ConvertFrom-Json',
        'Push-Location C:\\repo; Get-ChildItem; Pop-Location',
        '(Get-Content f).Length',
        '$first = $rows[0]; $first',
        '1..3 | ForEach-Object { $_ }',
        "Get-Content f -ErrorAction SilentlyContinue | Out-String",
        '$i = 0; $i++',
        "'a-b' -replace '-', '_'",
        'Get-Content f;',
      ],
      true,
    );
  });

  it('reads quotes and escapes inside strings as text', () => {
    expectAll(["Get-Content 'it''s.txt'", 'Get-Content "a""b.txt"', 'Get-Content "a`"b.txt"', "Select-String '#|&>' f"], true);
    expectAll(['Get-Content "unclosed', 'Get-Content "a`"b'], false);
  });

  it('allows script blocks and conditions written in the line', () => {
    expectAll(
      [
        "$raw = Get-Content C:\\repo\\out.json -Raw; $rows = (($raw -split 'STATS:')[1].Trim()) | ConvertFrom-Json; $i = 0; $lines = $rows | ForEach-Object { $i++; $short = ($_.id -split '_')[-1]; $dir = if ($_.signal -eq 'BUY') {'BULLISH'} elseif ($_.signal -eq 'SELL') {'BEARISH'} else {'NEUTRAL'}; '{0,3}  {1,-10} {2,-8}' -f $i, $short, $dir }; $lines.Count; $lines | Select-Object -First 5",
        '$rows | Where-Object { $_.score -gt 50 } | Select-Object -First 3',
        '$rows | ForEach-Object { $_.id }',
        '$rows | ForEach-Object -Begin { $n = 0 } -Process { $n++ } -End { $n }',
        "$dir = if ($x -eq 1) {'A'} else {'B'}; $dir",
        'if ($x) { Get-Content f }',
      ],
      true,
    );
  });

  it('allows the clock, discarded output, git and kubectl reads and configured prefixes', () => {
    expectAll(
      [
        "[DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm') + ' UTC'; Set-Location C:\\repo; git status --short -- src/ | Select-Object -First 5; git log --oneline origin/main..main | Select-Object -First 8",
        "[DateTime]::Now.AddDays(-1).ToString('s')",
        'Get-Process node 2>$null | Select-Object -First 3',
        'Get-Content f > $null',
        'Get-Content f *>&1 | Select-Object -First 1',
        'Set-Location C:\\repo; git log --oneline -2 2>$null; git diff --stat',
        'git status; git log --oneline -5 | Select-Object -First 3',
        "git -C 'C:\\my repo' status",
        'kubectl get pods -n app | Select-String worker',
        'Set-Location C:\\repo; npx tsc --noEmit -p tsconfig.build.json 2>&1 | Select-Object -First 8; "exit=$LASTEXITCODE"',
        'Set-Location C:\\repo; npx jest src/a.spec.ts src/b.spec.ts 2>&1 | Select-Object -Last 6; npx tsc --noEmit -p tsconfig.build.json 2>&1 | Select-Object -First 5; "tsc=$LASTEXITCODE"',
      ],
      true,
    );
    expectAll(['npx tsc --noEmit'], false, { prefixes: [], exported: new Set() });
  });

  it('refuses cmdlets and programs off the list, and writes', () => {
    expectAll(
      [
        'Remove-Item C:\\x -Recurse -Force',
        'Get-Content f.json | Out-File copy.json',
        'Get-Content f.txt > out.txt',
        'Get-Content f.txt 2> err.log',
        'Get-Content f >$nullx',
        'Set-Content f.txt "data"',
        'Invoke-Expression $cmd',
        'Stop-Process -Name node -Force',
        'New-Item -ItemType File x.txt',
        "$lines = $rows | ForEach-Object { '{0,3}' -f $_.id }; $lines | Out-File C:\\repo\\table.txt -Encoding utf8; $lines.Count",
        'Set-Location C:\\repo; git log --oneline -2 2>$null; git push 2>&1 | Select-Object -Last 2',
        'git checkout main',
        'kubectl delete pod x -n app',
        'npx evil-package',
        'npx tsc -p tsconfig.json',
        'npx -p evil-pkg tsc --noEmit',
        'Set-Location C:\\x; npx ts-node script.ts',
        // npx eslint is no configured prefix (and --fix writes).
        'npx eslint src/a.ts --fix 2>&1 | Select-Object -Last 2',
        // Aliases are not on the list: only full cmdlet names count.
        'ls',
        '',
        '   ',
      ],
      false,
    );
  });

  it('refuses call operators, static members, subexpressions, escapes, comments and stop-parsing', () => {
    expectAll(
      [
        '& notepad.exe',
        '[System.IO.File]::Delete("x")',
        "[DateTime]::UtcNow; [IO.File]::WriteAllText('x','y')",
        '[DateTime]::Parse($userInput)',
        '$x = [System.Diagnostics.Process]::Start("evil")',
        '"text $(Remove-Item x)"',
        '$(Remove-Item x)',
        'Get`-Content f; Remove-Item x',
        'cmd --% /c del x',
        'Get-Content f # note',
        '@{ a = 1 }',
        '@(1, 2)',
        "'unclosed",
        'Get-Content (f',
        '$x |',
        '| Get-Content f',
      ],
      false,
    );
  });

  it('refuses script blocks that write, and script blocks or names from elsewhere', () => {
    expectAll(
      [
        '$files | ForEach-Object { Remove-Item $_ }',
        '$rows | ForEach-Object { $_ | Out-File x.txt }',
        '$rows | Where-Object { Invoke-Expression $_.cmd }',
        // A name calls that method on every object.
        'Get-ChildItem | ForEach-Object Delete',
        'Get-ChildItem | ForEach-Object -MemberName Delete',
        // A block built from text runs it.
        "Get-ChildItem | ForEach-Object ([scriptblock]'Remove-Item x')",
        "Get-ChildItem | Where-Object ([ScriptBlock]::Create('Remove-Item x'))",
        // A variable or group could hold a block, which a parameter would run.
        '$sb = $x; Get-ChildItem | Where-Object $sb',
        'Get-ChildItem | Select-Object $properties',
        'Get-Content (Get-Item x)',
        "'a' -replace 'a', $b",
        "'a' -creplace 'a', { 'b' }",
        "'a' -split ($x)",
      ],
      false,
    );
  });

  it('refuses method calls off the list, however the name is written', () => {
    expectAll(
      [
        '$x.Delete()',
        "(Get-Item f).'Delete'()",
        '(Get-Item a).Replace(\'b\', \'c\')',
        '$x.$name()',
        '$x.Delete.Invoke()',
        'Get-ChildItem | ForEach-Object { $_.Delete() }',
      ],
      false,
    );
  });

  it('refuses casts, which build an object from text', () => {
    expectAll(["[IO.StreamWriter]'C:\\x'", "$a -eq[IO.StreamWriter]'C:\\x'", "'C:\\x' -as 'IO.StreamWriter'", "'C:\\x' -AS [IO.StreamWriter]"], false);
  });

  it('refuses variables that name a drive or a function, splats and variables PowerShell reads itself', () => {
    expectAll(
      [
        '${C:\\x.txt} = 1',
        '$C:x',
        '$function:x',
        '$p = 1; Get-ChildItem @p',
        "$PSDefaultParameterValues = 'x'",
        "$ErrorActionPreference = 'Stop'",
        "$OFS = ','",
        "$env:PATH = 'C:\\evil'",
        '$x.Prop = 1',
      ],
      false,
    );
    expectAll(['$env:PATH', "$env:PATH -split ';'"], true);
  });

  it('refuses ++ and -- on anything but a plain variable', () => {
    expectAll(['(Get-Item f).Length++', '$x.Count--', '$y = --$x', '5 -- $x', '$x = 1; $x+++1'], false);
  });

  it('refuses the common parameters that set a variable', () => {
    expectAll(['Get-ChildItem -OutVariable files', 'Get-ChildItem -ov files', 'Get-Process -ErrorVariable e', 'Get-Process -ev e', 'Get-Content f -PipelineVariable p'], false);
  });

  it('refuses text PowerShell reads as quotes, dashes or line breaks the checks do not', () => {
    expectAll(['Get-Content f –Raw', '‘x’', 'Get-Content f\u2028Remove-Item x', "@'\nRemove-Item x\n'@", 'Get-ChildItem\rRemove-Item x', 'Get-ChildItem\u0001'], false);
  });

  it('refuses a token that only starts with a digit, which names a program', () => {
    expectAll(['7z x archive.7z', '1password'], false);
  });

  it('refuses native arguments Windows PowerShell 5.1 passes as something else', () => {
    expectAll(
      [
        // An empty argument is dropped, so push becomes the subcommand.
        "git -C '' status push",
        // A quote or a final backslash inside a spaced argument splits or joins arguments.
        'git log \'a"b\'',
        'git log "a`"b"',
        "git -C 'my repo\\' status",
        'git log $a,$b',
        'git log "$x"',
      ],
      false,
    );
  });
});
