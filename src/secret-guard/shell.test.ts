import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { describeFinding } from './findings.ts';
import { secretRulesOf } from './rules.ts';
import { shellFindings } from './shell.ts';

const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');

function printed(command: string, dialect: ShellDialect = 'bash'): string[] {
  return shellFindings(command, { cwd: 'C:/w', home: 'C:/u', dialect }, rules).map(describeFinding);
}

describe('shellFindings', () => {
  it('names each secret a line would print, once', () => {
    assert.deepEqual(printed('cat .env; cat .env; printenv GITHUB_TOKEN; echo "$(cat ~/.npmrc)"'), [
      'the content of .env',
      'the value of $GITHUB_TOKEN',
      'the content of ~/.npmrc',
    ]);
    assert.deepEqual(printed('$env:GITHUB_TOKEN; [Environment]::GetEnvironmentVariable("NPM_TOKEN")', 'powershell'), [
      'the value of $GITHUB_TOKEN',
      'the value of $NPM_TOKEN',
    ]);
  });

  it('lets a line pass when no secret it reads reaches the screen', () => {
    const lines = [
      'cat .env | wc -c',
      'grep -q GITHUB_TOKEN .env',
      'curl -H "Authorization: Bearer $(cat ~/.token)" https://x',
      'X=$(cat .env); echo done',
      'printenv | wc -l',
      'cat ~/.npmrc > /tmp/npmrc.bak',
      'echo "$GITHUB_TOKEN" | docker login ghcr.io -u me --password-stdin',
      'node -e "fetch(u, {headers: {a: process.env.NPM_TOKEN}})"',
      'ssh host "cat .env | sha256sum"',
      'kubectl config view --raw > kube.bak',
      'kubectl config view',
    ];
    assert.deepEqual(lines.filter((line) => printed(line).length > 0), []);
    assert.deepEqual(printed('[Environment]::GetEnvironmentVariable("NPM_TOKEN") | Set-Clipboard; if ($env:GH_TOKEN) { "set" }', 'powershell'), []);
  });

  it('reads the lines a container or a remote host runs, to a depth', () => {
    assert.deepEqual(printed("kubectl exec p -- sh -c 'cat .env'"), ['the content of .env']);
    assert.deepEqual(printed('kubectl get secret app -o yaml'), ["a Kubernetes secret's data"]);
    assert.deepEqual(printed('ssh a kubectl config view --raw'), ["the secrets in this kubectl command's output"]);
    assert.deepEqual(printed('ssh a ssh b ssh c ssh d cat .env'), ['the content of .env']);
    assert.deepEqual(printed('ssh a ssh b ssh c ssh d ssh e cat .env'), []);
  });
});
