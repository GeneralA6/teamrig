import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DEFAULT_COMMITS } from '../config/defaults.ts';
import type { CommitGate } from '../config/types.ts';
import { isRecord } from '../core/guards.ts';
import type { CommitStat } from '../push-guard/commit-size.ts';
import type { RepoState } from '../push-guard/push.ts';
import { testConfig } from '../testing/config.ts';
import { commitsOf, protectedBranchesOf, pushGuardOutput, type PushGuardEnv } from './push-guard.ts';

function fakeRepo(branch: string) {
  return {
    branch: mock.fn((_dir: string): string | undefined => branch),
    pushTarget: mock.fn((_dir: string): string | undefined => undefined),
  } satisfies RepoState;
}

function env(branch = 'feature') {
  return {
    cwd: '/fallback',
    home: '/u',
    repo: fakeRepo(branch),
    protectedBranches: ['main'],
    commits: DEFAULT_COMMITS,
    commitLog: { between: () => [] },
  } satisfies PushGuardEnv;
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

describe('pushGuardOutput: the commits gate', () => {
  const big = { sha: 'b'.repeat(40), subject: 'Rewrite the store', body: '', files: [{ path: 'src/store.ts', added: 900, deleted: 0 }] };
  const small = { sha: 's'.repeat(40), subject: 'Fix a typo', body: '', files: [{ path: 'src/a.ts', added: 1, deleted: 1 }] };

  /** `unknown`: git cannot list the range. */
  function gated(gate: CommitGate, commits: readonly CommitStat[] | 'unknown' = [big, small]) {
    const between = mock.fn((_dir: string, _base: string, _tip: string): readonly CommitStat[] | undefined => (commits === 'unknown' ? undefined : commits));
    return { env: { ...env(), commits: { ...DEFAULT_COMMITS, gate }, commitLog: { between } } satisfies PushGuardEnv, between };
  }

  function hookOutput(output: string): { decision: unknown; reason: string } {
    const parsed: unknown = JSON.parse(output);
    assert.ok(isRecord(parsed) && isRecord(parsed['hookSpecificOutput']));
    return { decision: parsed['hookSpecificOutput']['permissionDecision'], reason: String(parsed['hookSpecificOutput']['permissionDecisionReason']) };
  }

  it('warn: asks, and lists each large commit once across the updates', () => {
    const { env: warn, between } = gated('warn');
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main feature:main'), warn));
    assert.equal(decision, 'ask');
    assert.match(reason, /^This push updates a protected branch \(main\)/);
    assert.match(reason, /1 commit\(s\) go over 400 changed non-test lines .*bbbbbbb "Rewrite the store" \(900 line\(s\), 1 file\(s\)\)/);
    assert.deepEqual(
      between.mock.calls.map((call) => call.arguments),
      [
        ['/work/app', 'origin/main', 'HEAD'],
        ['/work/app', 'origin/main', 'feature'],
      ],
    );
  });

  it('refuse: refuses a push that sends a large commit, and only asks without one', () => {
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), gated('refuse').env));
    assert.equal(decision, 'deny');
    assert.match(reason, /^This push to a protected branch \(main\) is refused: 1 commit\(s\) go over/);
    assert.equal(hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), gated('refuse', [small]).env)).decision, 'ask');
  });

  it('never reads the log when the gate is off, the push is refused anyway, or nothing is protected', () => {
    for (const [gate, command] of [
      ['off', 'git push origin HEAD:main'],
      ['refuse', 'git push -f origin main'],
      ['refuse', 'git push origin feature'],
    ] as const) {
      const { env: gatedEnv, between } = gated(gate);
      pushGuardOutput(payload(command), gatedEnv);
      assert.equal(between.mock.callCount(), 0, `${gate}: ${command}`);
    }
  });

  it('asks as usual when git cannot list the commits', () => {
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), gated('refuse', 'unknown').env));
    assert.equal(decision, 'ask');
    assert.doesNotMatch(reason, /commit\(s\) go over/);
  });
});

describe('commitsOf', () => {
  it("uses the team's rule when the config loads, else the defaults", () => {
    const config = testConfig({ commits: { gate: 'refuse' } });
    assert.equal(commitsOf({ status: 'loaded', path: 'c.json', config, issues: [] }).gate, 'refuse');
    assert.deepEqual(commitsOf({ status: 'missing', path: 'c.json' }), DEFAULT_COMMITS);
  });
});
