import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isRecord } from '../core/guards.ts';
import type { RepoState } from '../push-guard/push.ts';
import { testConfig } from '../testing/config.ts';
import { protectedBranchesOf, pushGuardOutput, type PushGuardEnv } from './push-guard.ts';

function fakeRepo(branch: string) {
  return {
    branch: mock.fn((_dir: string): string | undefined => branch),
    pushTarget: mock.fn((_dir: string): string | undefined => undefined),
  } satisfies RepoState;
}

function env(branch = 'feature') {
  return { cwd: '/fallback', home: '/u', repo: fakeRepo(branch), protectedBranches: ['main'] } satisfies PushGuardEnv;
}

const payload = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', cwd: '/work/app', tool_input: { command }, ...extra });

function decisionOf(output: string): unknown {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed) && isRecord(parsed['hookSpecificOutput']));
  assert.equal(parsed['hookSpecificOutput']['hookEventName'], 'PreToolUse');
  assert.match(String(parsed['hookSpecificOutput']['permissionDecisionReason']), /protected branch \(main\)/);
  return parsed['hookSpecificOutput']['permissionDecision'];
}

describe('pushGuardOutput', () => {
  it('asks before a push to a protected branch and denies a force-push', () => {
    assert.equal(decisionOf(pushGuardOutput(payload('git push origin main'), env())), 'ask');
    assert.equal(decisionOf(pushGuardOutput(payload('git push -f origin main'), env())), 'deny');
  });

  it('emits nothing for a branch push, a heredoc note or a payload without a command', () => {
    assert.equal(pushGuardOutput(payload('git push origin feature'), env()), '');
    assert.equal(pushGuardOutput(payload("cat > n.md <<'EOF'\ngit push origin main\nEOF"), env()), '');
    assert.equal(pushGuardOutput({ tool_name: 'Read', tool_input: { file_path: 'x' } }, env()), '');
    assert.equal(pushGuardOutput('not an object', env()), '');
  });

  it('reads PowerShell commands with the PowerShell escape rules', () => {
    const command = "git commit -m @'\ngit push origin main\n'@";
    assert.equal(pushGuardOutput(payload(command, { tool_name: 'PowerShell' }), env()), '');
    assert.equal(decisionOf(pushGuardOutput(payload('git push origin main; Write-Host ok', { tool_name: 'PowerShell' }), env())), 'ask');
  });

  it("resolves a bare push in the payload's folder, else the hook's own", () => {
    const withCwd = env('main');
    pushGuardOutput(payload('git push'), withCwd);
    assert.equal(withCwd.repo.branch.mock.calls[0]?.arguments[0], '/work/app');

    const without = env('main');
    pushGuardOutput({ tool_name: 'Bash', tool_input: { command: 'git -C sub push' } }, without);
    assert.equal(without.repo.branch.mock.calls[0]?.arguments[0], resolve('/fallback', 'sub'));
  });
});

describe('protectedBranchesOf', () => {
  it("uses the team's branches when the config loads, else the defaults", () => {
    const config = testConfig({ pushGuard: { protectedBranches: ['trunk'] } });
    assert.deepEqual(protectedBranchesOf({ status: 'loaded', path: 'c.json', config, issues: [] }), ['trunk']);
    assert.deepEqual(protectedBranchesOf({ status: 'missing', path: 'c.json' }), ['main', 'master']);
    assert.deepEqual(protectedBranchesOf({ status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } }), ['main', 'master']);
  });
});
