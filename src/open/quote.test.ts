import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posixQuote, powershellQuote, shellCommand } from './quote.ts';

// The long, real form: a Windows runner's temp folder can hold an 8.3 short name (RUNNER~1),
// which the shell expands for the program it starts, and macOS's /var is a link to /private/var.
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'teamrig-quote-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** What a shell could read as syntax, in one argument, using only what a Windows file name may hold. */
const HOSTILE = `a b'c;d&e\`g\`$(id)$HOME %PATH% \u2019h\u2018 [x] #i@{y}`;
/** The rest, which only a POSIX file name may hold. */
const POSIX_HOSTILE = `${HOSTILE} |f *? "q"\nr`;

describe('posixQuote', () => {
  it('single-quotes every argument and closes and reopens around a quote', () => {
    assert.equal(posixQuote('plain'), "'plain'");
    assert.equal(posixQuote(''), "''");
    assert.equal(posixQuote("it's"), "'it'\\''s'");
    assert.equal(posixQuote('$(id)`id`;&|"\n'), "'$(id)`id`;&|\"\n'");
  });
});

describe('powershellQuote', () => {
  it('doubles every kind of single quote, and leaves the rest as text', () => {
    assert.equal(powershellQuote('plain'), "'plain'");
    assert.equal(powershellQuote("it's"), "'it''s'");
    assert.equal(powershellQuote('\u2018a\u2019b\u201ac\u201bd'), "'\u2018\u2018a\u2019\u2019b\u201a\u201ac\u201b\u201bd'");
    assert.equal(powershellQuote('$env:PATH; `n %PATH% &'), "'$env:PATH; `n %PATH% &'");
  });
});

describe('shellCommand', () => {
  it('changes to the folder, then runs the quoted arguments', () => {
    assert.equal(shellCommand('linux', '/w/a b', ['/usr/bin/node', "x'y"]), "cd '/w/a b' && '/usr/bin/node' 'x'\\''y'");
    assert.equal(shellCommand('darwin', '/w', ['n']), "cd '/w' && 'n'");
    assert.equal(
      shellCommand('win32', 'C:\\w\\it\u2019s', ['C:\\node.exe', 'launch']),
      "Set-Location -LiteralPath 'C:\\w\\it\u2019\u2019s'; & 'C:\\node.exe' 'launch'",
    );
  });

  // The command really runs: the native shell must hand every hostile argument and folder through whole.
  it('survives hostile arguments and a hostile folder in this platform shell', () => {
    // Windows PowerShell also drops a " it passes to a program; a Windows path never holds one.
    const folderName = process.platform === 'win32' ? HOSTILE : POSIX_HOSTILE;
    const folder = join(ROOT, folderName);
    mkdirSync(folder);
    const echo = join(ROOT, 'echo-args.js');
    writeFileSync(echo, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n');
    const args = process.platform === 'win32' ? [HOSTILE, 'launch'] : [POSIX_HOSTILE, 'launch'];
    const text = shellCommand(process.platform, folder, [process.execPath, echo, ...args]);
    const result =
      process.platform === 'win32'
        ? runPowerShell(text)
        : spawnSync('sh', ['-c', text], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const printed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(printed, { cwd: folder, args });
  });
});

/** Runs a script file, so no second layer of command-line quoting stands between it and PowerShell. */
function runPowerShell(script: string): SpawnSyncReturns<string> {
  const file = join(ROOT, 'run.ps1');
  // Windows PowerShell reads a script without a byte order mark as the ANSI code page.
  writeFileSync(file, `\ufeff[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}\n`, 'utf8');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' });
}
