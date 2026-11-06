import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolUseFrom } from './line.ts';
import { isCoordinationTool } from './use-class.ts';

const bash = (command: string): boolean => isCoordinationTool(toolUseFrom('t', 'Bash', { command }));
const powershell = (command: string): boolean => isCoordinationTool(toolUseFrom('t', 'PowerShell', { command }));

describe('isCoordinationTool, a shell call', () => {
  it('takes the commands that read or write the register, however teamrig is started', () => {
    assert.equal(bash('teamrig inbox read --session a'), true);
    assert.equal(bash('env -C /repo teamrig list --session a'), true);
    assert.equal(bash('node /kit/dist/cli/main.js show T1'), true);
    assert.equal(bash('node src/cli/main.ts set T1 --status done'), true);
    assert.equal(powershell('& "C:/kit/teamrig.cmd" check'), true);
    assert.equal(bash('A=$(teamrig list)'), true);
  });

  it('leaves the teamrig commands that do the work', () => {
    assert.equal(bash('teamrig worktree add t1-branch'), false);
    assert.equal(bash('teamrig merge t1-branch'), false);
    assert.equal(bash('teamrig'), false);
  });

  it('reads through the wrapper to the test a teamrig test runs', () => {
    assert.equal(bash('teamrig test --session a -- node --test src/a.test.ts'), false);
  });

  it('takes a call of nothing but shell scaffolding', () => {
    assert.equal(bash('echo done; date -u'), true);
    assert.equal(bash('cd /repo'), true);
    assert.equal(bash('export A=1'), true);
    assert.equal(bash('A=1'), true);
    assert.equal(bash('for f in a b; do echo $f; done'), true);
    assert.equal(powershell('Write-Output hi; Get-Date; Set-Location x'), true);
  });

  it('is work once any program in the call is', () => {
    assert.equal(bash('teamrig list; npm test'), false);
    assert.equal(bash('teamrig list && git status'), false);
    assert.equal(bash('npm run build; teamrig set T1 --status done'), false);
  });

  it('lets the first stage of a pipe decide', () => {
    assert.equal(bash('teamrig list | grep T1'), true);
    assert.equal(bash('npm test | tail -5'), false);
  });

  it('takes a handover read or written from the shell, and no other file', () => {
    assert.equal(bash('cat /kit/teams/a/handover/b.md'), true);
    assert.equal(bash('cat <<EOF > /kit/teams/a/handover/b.md\nhi\nEOF'), true);
    assert.equal(powershell('Get-Content C:\\teams\\a\\handover\\b.md'), true);
    assert.equal(bash('cat src/a.ts'), false);
    assert.equal(bash('sed -n 1,2p src/a.ts'), false);
  });

  it('counts what it cannot read as work', () => {
    assert.equal(bash('$X list'), false);
    assert.equal(bash('echo hi | bash'), false);
    assert.equal(powershell('$x = 1'), false);
  });

  it('counts a script a shell runs as work', () => {
    assert.equal(bash('bash script.sh'), false);
    assert.equal(bash('sh ./a.sh'), false);
    assert.equal(bash('/bin/bash -x a.sh'), false);
    assert.equal(powershell('pwsh -File a.ps1'), false);
    assert.equal(powershell('powershell.exe -File a.ps1'), false);
  });

  it('is work with no command to read', () => {
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Bash', {})), false);
  });
});

describe('isCoordinationTool, any other tool', () => {
  it('takes Read, Edit and Write only on a handover', () => {
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Read', { file_path: '/kit/teams/a/handover/b.md' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Edit', { file_path: 'C:\\teams\\a\\handover\\b.md' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Write', { file_path: '/kit/teams/a/handover/b.md' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Read', { file_path: 'src/a.ts' })), false);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Read', {})), false);
  });

  it('takes messages to a peer', () => {
    assert.equal(isCoordinationTool(toolUseFrom('t', 'SendMessage', { to: 'a', message: 'b' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'ListAgents', {})), true);
  });

  it('takes only the skills that run the team', () => {
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Skill', { skill: 'team-assign-task' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Skill', { skill: 'teamrig:approvals' })), true);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Skill', { skill: 'dev-ship-change' })), false);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Skill', {})), false);
  });

  it('is work for the rest', () => {
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Grep', { pattern: 'a', path: 'src' })), false);
    assert.equal(isCoordinationTool(toolUseFrom('t', 'Agent', { prompt: 'a' })), false);
  });
});
