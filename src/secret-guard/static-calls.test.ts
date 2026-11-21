import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { runsOf } from '../package-guard/programs.ts';
import { testPaths } from '../testing/host.ts';
import { describeFinding } from './findings.ts';
import type { WordPlace } from './paths.ts';
import { secretRulesOf } from './rules.ts';
import { consoleWriteFindings, fileReadFindings, groupFrom } from './static-calls.ts';

const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32', testPaths());
const PLACE: WordPlace = { dialect: 'powershell', dir: 'C:/w', home: 'C:/u' };

function written(command: string): string[] {
  return consoleWriteFindings(command, rules.names).map(describeFinding);
}

function read(command: string): string[] {
  return runsOf(command, { cwd: PLACE.dir, home: PLACE.home, dialect: 'powershell' }).bare.flatMap((bare) =>
    fileReadFindings(bare, PLACE, rules.paths).map(describeFinding),
  );
}

describe('groupFrom', () => {
  it('reads a group to its closing ), past nested groups and the parentheses in quotes', () => {
    assert.equal(groupFrom('f(a, (b)) + c', 2), 'a, (b)');
    assert.equal(groupFrom(`f(")" + 'x)''' + "a\`")" + $b) | y`, 2), `")" + 'x)''' + "a\`")" + $b`);
  });

  it('takes the rest of the text when the group never closes, the safe side', () => {
    assert.equal(groupFrom('f($env:A', 2), '$env:A');
  });
});

describe('consoleWriteFindings', () => {
  it('names the secret each [Console] write prints, wherever it stands on the line (T2017)', () => {
    assert.deepEqual(written('[Console]::WriteLine($env:GITHUB_TOKEN)'), ['the value of $GITHUB_TOKEN']);
    assert.deepEqual(written('[System.Console]::Write("t=" + $env:NPM_TOKEN)'), ['the value of $NPM_TOKEN']);
    assert.deepEqual(written('$null = [Console]::Out.WriteLine($env:GITHUB_TOKEN)'), ['the value of $GITHUB_TOKEN']);
    assert.deepEqual(written('if ($true) { [console]::Error.WriteLine("{0}", $env:GITHUB_TOKEN) }'), ['the value of $GITHUB_TOKEN']);
    assert.deepEqual(written('[Console]::WriteLine([Environment]::GetEnvironmentVariable("NPM_TOKEN"))'), ['the value of $NPM_TOKEN']);
  });

  it('passes a write of no secret, or of a secret only tested, and a write the line only names', () => {
    assert.deepEqual(written('[Console]::WriteLine($env:HOME)'), []);
    assert.deepEqual(written('[Console]::WriteLine($env:GITHUB_TOKEN.Length)'), []);
    assert.deepEqual(written('[Console]::WriteLine("done"); $env:GITHUB_TOKEN | Set-Clipboard'), []);
    assert.deepEqual(written('[Console]::ReadLine()'), []);
  });
});

describe('fileReadFindings', () => {
  it('names a secret file a printed .NET whole-file read spells out (T2017)', () => {
    assert.deepEqual(read('[IO.File]::ReadAllText(".env")'), ['the content of .env']);
    assert.deepEqual(read("[System.IO.File]::ReadAllLines('~/.npmrc')"), ['the content of ~/.npmrc']);
    assert.deepEqual(read('[IO.File]::ReadAllBytes("$HOME\\.ssh\\id_ed25519")'), ['the content of $HOME\\.ssh\\id_ed25519']);
    assert.deepEqual(read('[io.file]::ReadLines("C:/w/api/.env.local", [Text.Encoding]::UTF8)'), ['the content of C:/w/api/.env.local']);
  });

  it('passes a read that prints nothing, of no secret, or of a path only known when it runs', () => {
    assert.deepEqual(read('$x = [IO.File]::ReadAllText(".env")'), []);
    assert.deepEqual(read('[IO.File]::ReadAllText(".env") -eq ""'), []);
    assert.deepEqual(read('[IO.File]::ReadAllText(".env.example")'), []);
    assert.deepEqual(read('[IO.File]::ReadAllText($path)'), []);
    assert.deepEqual(read('[IO.File]::Exists(".env")'), []);
    assert.deepEqual(read('[IO.File]::ReadAllText(".env*")'), [], '.NET reads a * as part of the name, never a wildcard');
    assert.deepEqual(read('[IO.File]::ReadAllText'), []);
  });
});
