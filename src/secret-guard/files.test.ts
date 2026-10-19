import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { programsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { fileFindings, isPrinter } from './files.ts';
import { describeFinding } from './findings.ts';
import { secretRulesOf } from './rules.ts';

const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');

/** What the line's programs print by file, each program's output taken as printed. */
function printed(command: string, dialect: ShellDialect = 'bash'): string[] {
  return programsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect })
    .flatMap((run) => fileFindings(run, rules))
    .map(describeFinding);
}

describe('fileFindings', () => {
  it('names the secret files a printer prints, by argument, option value or stdin', () => {
    assert.deepEqual(printed('cat .env; head -5 ~/.ssh/id_rsa; sort < /w/app/.env.local; dd if=server.key; tr -d x < .env'), [
      'the content of .env',
      'the content of ~/.ssh/id_rsa',
      'the content of /w/app/.env.local',
      'the content of server.key',
      'the content of .env',
    ]);
  });

  it('lets a kept file, a public key and a program that prints no content pass', () => {
    assert.deepEqual(printed('cat .env.example ~/.ssh/id_rsa.pub; ls -la .env; cp .env .env.bak; wc -c .env; cat README.md'), []);
  });

  it('reads a wildcard as the secret names it may match, with no leading dot in bash', () => {
    assert.deepEqual(printed('cat .env*; cat certs/*.pem'), ['the content of .env*', 'the content of certs/*.pem']);
    assert.deepEqual(printed('grep TOKEN *'), []);
    assert.deepEqual(printed('Get-Content *', 'powershell'), ['the content of *']);
  });

  it("reads a process's environ file as the environment", () => {
    assert.deepEqual(printed('cat /proc/self/environ; tr "\\0" "\\n" < /proc/1/environ'), ['the whole environment', 'the whole environment']);
  });

  it('names the files a git call prints, and only with a patch for a log', () => {
    assert.deepEqual(printed('git show HEAD:.env; git log -p -- .env; git -C /w diff .env'), [
      'the content of .env',
      'the content of .env',
      'the content of .env',
    ]);
    assert.deepEqual(printed('git log -- .env; git status; git add .env; git -c core.pager=cat log --stat'), []);
  });

  it('reads PowerShell and cmd printers', () => {
    assert.deepEqual(printed('Get-Content ~/.npmrc; gc -Path .env -Raw', 'powershell'), ['the content of ~/.npmrc', 'the content of .env']);
    assert.deepEqual(printed('cmd /c type .env'), ['the content of .env']);
  });

  it('knows the printers by name', () => {
    assert.equal(isPrinter('get-content'), true);
    assert.equal(isPrinter('tee'), false);
  });
});
