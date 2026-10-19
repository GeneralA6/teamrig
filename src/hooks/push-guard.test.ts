import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DEFAULT_COMMITS } from '../config/defaults.ts';
import type { CommitGate, PushToProtected, SkipHooks } from '../config/types.ts';
import { isRecord } from '../core/guards.ts';
import type { CommitStat } from '../push-guard/commit-size.ts';
import type { ConfigValue } from '../push-guard/invocations.ts';
import { leasedReason, type RepoState } from '../push-guard/push.ts';
import { testConfig } from '../testing/config.ts';
import {
  allowedPushNote,
  commitsOf,
  PUSH_TO_PROTECTED_HINT,
  protectedBranchesOf,
  pushGuardOutput,
  pushToProtectedOf,
  skipHooksOf,
  skipHooksReason,
  type PushGuardEnv,
} from './push-guard.ts';

function fakeRepo(branch: string) {
  return {
    branch: mock.fn((_dir: string): string | undefined => branch),
    head: mock.fn((_dir: string): string | undefined => undefined),
    pushTarget: mock.fn((_dir: string, _branch?: string): string | undefined => undefined),
    config: mock.fn((_dir: string, _key: string): ConfigValue => ({ kind: 'unset' })),
  } satisfies RepoState;
}

function env(branch = 'feature') {
  return {
    cwd: '/fallback',
    home: '/u',
    repo: fakeRepo(branch),
    protectedBranches: ['main'],
    pushToProtected: 'ask',
    commits: DEFAULT_COMMITS,
    commitLog: { between: () => [] },
    skipHooks: 'deny',
  } satisfies PushGuardEnv;
}

const CHOICES: readonly PushToProtected[] = ['ask', 'allow'];

const payload = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', cwd: '/work/app', tool_input: { command }, ...extra });

function decisionOf(output: string): unknown {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed) && isRecord(parsed['hookSpecificOutput']));
  assert.equal(parsed['hookSpecificOutput']['hookEventName'], 'PreToolUse');
  assert.match(String(parsed['hookSpecificOutput']['permissionDecisionReason']), /protected branch \(main\)/);
  return parsed['hookSpecificOutput']['permissionDecision'];
}

function hookOutput(output: string): { decision: unknown; reason: string } {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed) && isRecord(parsed['hookSpecificOutput']));
  return { decision: parsed['hookSpecificOutput']['permissionDecision'], reason: String(parsed['hookSpecificOutput']['permissionDecisionReason']) };
}

/** The note an allowed push gets: a `systemMessage` and no permission decision, so the normal permission flow decides. */
function noteOf(output: string): string {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed));
  assert.deepEqual(Object.keys(parsed), ['systemMessage']);
  return String(parsed['systemMessage']);
}

describe('pushGuardOutput', () => {
  it('asks before a push to a protected branch, naming the switch, and denies a force-push without it', () => {
    const asked = hookOutput(pushGuardOutput(payload('git push origin main'), env()));
    assert.equal(asked.decision, 'ask');
    assert.match(asked.reason, /^This push updates a protected branch \(main\)/);
    assert.ok(asked.reason.endsWith(` ${PUSH_TO_PROTECTED_HINT}`), asked.reason);
    assert.equal(PUSH_TO_PROTECTED_HINT, "To stop asking about normal pushes, set pushGuard.pushToProtected to allow in the team's config.json.");
    const denied = pushGuardOutput(payload('git push -f origin main'), env());
    assert.equal(decisionOf(denied), 'deny');
    assert.doesNotMatch(denied, /pushToProtected/);
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
    assert.equal(withCwd.repo.branch.mock.calls[0]?.arguments[0], resolve('/work/app'));

    const without = env('main');
    pushGuardOutput({ tool_name: 'Bash', tool_input: { command: 'git -C sub push' } }, without);
    assert.equal(without.repo.branch.mock.calls[0]?.arguments[0], resolve('/fallback', 'sub'));
  });

  it('asks, saying what it cannot read, about a push it cannot read with confidence', () => {
    for (const command of ['git -C "$REPO" push', 'cd "$REPO" && git push', "bash -c 'git push origin feature", 'git push $ARGS']) {
      const output = pushGuardOutput(payload(command), env());
      assert.equal(decisionOf(output), 'ask', command);
      assert.match(output, /The guard cannot tell whether this command pushes to a protected branch \(main\): .+\. Confirm, or write the push out plainly\./, command);
      assert.doesNotMatch(output, /pushToProtected/, command);
    }
  });

  it('emits nothing when no branch is protected, even for a mirror, a force-push or a line it cannot read', () => {
    for (const command of ['git push --mirror origin', 'git push -f origin main', 'git push $ARGS', 'git push origin main']) {
      assert.equal(pushGuardOutput(payload(command), { ...env(), protectedBranches: [] }), '', command);
    }
  });

  it('runs a PowerShell call operator and a cmd /c line through the same rules', () => {
    assert.equal(decisionOf(pushGuardOutput(payload("& 'C:\\Program Files\\Git\\cmd\\git.exe' push origin main", { tool_name: 'PowerShell' }), env())), 'ask');
    assert.equal(decisionOf(pushGuardOutput(payload('cmd /c "git push -f origin main"', { tool_name: 'PowerShell' }), env())), 'deny');
  });
});

describe('pushGuardOutput: pushToProtected', () => {
  const allow = (): PushGuardEnv => ({ ...env(), pushToProtected: 'allow' });

  it('allow: lets a normal push to a protected branch through with a one-line note', () => {
    for (const command of ['git push origin main', 'git push origin HEAD:main', 'git push --all origin', 'git push origin :']) {
      assert.equal(noteOf(pushGuardOutput(payload(command), allow())), 'teamrig did not ask about this push to a protected branch (main): pushGuard.pushToProtected is allow.', command);
    }
    assert.equal(allowedPushNote(['main', 'master']), 'teamrig did not ask about this push to a protected branch (main, master): pushGuard.pushToProtected is allow.');
    assert.equal(pushGuardOutput(payload('git push origin feature'), allow()), '');
  });

  it('allow: still refuses a force-push, mirror or delete, without naming the switch', () => {
    for (const command of ['git push -f origin main', 'git push --mirror origin', 'git push origin --delete main', 'git push origin :main']) {
      const output = pushGuardOutput(payload(command), allow());
      assert.equal(decisionOf(output), 'deny', command);
      assert.doesNotMatch(output, /pushToProtected/, command);
    }
  });

  it('allow: still asks about a line it cannot read, without naming the switch', () => {
    for (const command of ['git push $ARGS', 'git push origin main; git push $ARGS']) {
      const { decision, reason } = hookOutput(pushGuardOutput(payload(command), allow()));
      assert.equal(decision, 'ask', command);
      assert.match(reason, /^The guard cannot tell whether this command pushes to a protected branch \(main\)/, command);
      assert.doesNotMatch(reason, /pushToProtected/, command);
    }
  });

  it('asks about a --force-with-lease push under either choice, without naming the switch', () => {
    for (const choice of CHOICES) {
      const { decision, reason } = hookOutput(pushGuardOutput(payload('git push --force-with-lease origin main'), { ...env(), pushToProtected: choice }));
      assert.deepEqual([decision, reason], ['ask', leasedReason(['main'])], choice);
    }
  });
});

describe('pushToProtectedOf', () => {
  it("uses the team's choice when the config loads, else asks", () => {
    const config = testConfig({ pushGuard: { pushToProtected: 'allow' } });
    assert.equal(pushToProtectedOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'allow');
    assert.equal(pushToProtectedOf({ status: 'loaded', path: 'c.json', config: testConfig(), issues: [] }), 'ask');
    assert.equal(pushToProtectedOf({ status: 'missing', path: 'c.json' }), 'ask');
    assert.equal(pushToProtectedOf({ status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } }), 'ask');
    assert.equal(pushToProtectedOf(undefined), 'ask');
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

  it('warn: asks, and lists each large commit once across the updates, before naming the switch', () => {
    const { env: warn, between } = gated('warn');
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main feature:main'), warn));
    assert.equal(decision, 'ask');
    assert.match(reason, /^This push updates a protected branch \(main\)/);
    assert.match(reason, /1 commit\(s\) go over 400 changed non-test lines .*bbbbbbb "Rewrite the store" \(900 line\(s\), 1 file\(s\)\)\..* To stop asking/);
    assert.ok(reason.endsWith(PUSH_TO_PROTECTED_HINT), reason);
    assert.deepEqual(
      between.mock.calls.map((call) => call.arguments),
      [
        [resolve('/work/app'), 'origin/main', 'HEAD'],
        [resolve('/work/app'), 'origin/main', 'feature'],
      ],
    );
  });

  it('refuse: refuses a push that sends a large commit, and only asks without one', () => {
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), gated('refuse').env));
    assert.equal(decision, 'deny');
    assert.match(reason, /^This push to a protected branch \(main\) is refused: 1 commit\(s\) go over/);
    assert.equal(hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), gated('refuse', [small]).env)).decision, 'ask');
  });

  it('allow: refuses a push that sends a large commit under refuse, and lists them in the note under warn', () => {
    const refused = hookOutput(pushGuardOutput(payload('git push origin HEAD:main'), { ...gated('refuse').env, pushToProtected: 'allow' }));
    assert.equal(refused.decision, 'deny');
    assert.match(refused.reason, /^This push to a protected branch \(main\) is refused: 1 commit\(s\) go over/);
    const warned = noteOf(pushGuardOutput(payload('git push origin HEAD:main'), { ...gated('warn').env, pushToProtected: 'allow' }));
    assert.match(warned, /^teamrig did not ask about this push to a protected branch \(main\): pushGuard\.pushToProtected is allow\. 1 commit\(s\) go over/);
    const quiet = noteOf(pushGuardOutput(payload('git push origin HEAD:main'), { ...gated('refuse', [small]).env, pushToProtected: 'allow' }));
    assert.equal(quiet, allowedPushNote(['main']));
  });

  it('allow: lists the large commits in the doubt question of a line it partly cannot read', () => {
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git push origin HEAD:main; git push $ARGS'), { ...gated('warn').env, pushToProtected: 'allow' }));
    assert.equal(decision, 'ask');
    assert.match(reason, /^The guard cannot tell .* 1 commit\(s\) go over/);
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

describe('pushGuardOutput: skipped hooks', () => {
  const skipping = (skipHooks: SkipHooks): PushGuardEnv => ({ ...env(), skipHooks });

  it('refuses a git command run without the hooks under deny, naming each skip and the switch', () => {
    const { decision, reason } = hookOutput(pushGuardOutput(payload('git add -A && git commit --no-verify -m fix && HUSKY=0 git push origin feature'), skipping('deny')));
    assert.equal(decision, 'deny');
    assert.equal(reason, skipHooksReason([
      { dir: resolve('/work/app'), subcommand: 'commit', by: '--no-verify' },
      { dir: resolve('/work/app'), subcommand: 'push', by: 'HUSKY=0' },
    ]));
    assert.equal(
      reason,
      "teamrig commit guard: this runs git without the repository's hooks: git commit (--no-verify), git push (HUSKY=0). The hooks are the " +
        "repository's own checks: let them run and fix what they report; if a hook itself is broken, tell the lead. [commitGuard.skipHooks]",
    );
  });

  it('asks under ask, keeps refusing a force-push to a protected branch, and emits nothing under allow', () => {
    assert.deepEqual(hookOutput(pushGuardOutput(payload('git commit -n -m fix'), skipping('ask'))).decision, 'ask');
    const forced = hookOutput(pushGuardOutput(payload('git push --no-verify -f origin main'), skipping('ask')));
    assert.equal(forced.decision, 'deny');
    assert.match(forced.reason, /^Force-pushing, mirroring or deleting a protected branch \(main\)/);
    assert.equal(pushGuardOutput(payload('git commit --no-verify -m fix'), skipping('allow')), '');
    assert.equal(decisionOf(pushGuardOutput(payload('git push --no-verify origin main'), skipping('allow'))), 'ask', 'allow leaves the push question');
  });

  it('refuses one even when no branch is protected, in PowerShell too, and leaves a line whose hooks run', () => {
    const unguarded: PushGuardEnv = { ...env(), protectedBranches: [] };
    assert.equal(hookOutput(pushGuardOutput(payload('git commit -nm fix'), unguarded)).decision, 'deny');
    assert.equal(hookOutput(pushGuardOutput(payload('git -c core.hooksPath=NUL commit -m fix', { tool_name: 'PowerShell' }), env())).decision, 'deny');
    for (const command of ['git commit -m "skip --no-verify next time"', 'git push -n origin feature', 'git config --get core.hooksPath']) {
      assert.equal(pushGuardOutput(payload(command), env()), '', command);
    }
  });
});

describe('skipHooksOf', () => {
  it("uses the team's choice when the config loads, else refuses", () => {
    const config = testConfig({ commitGuard: { skipHooks: 'ask' } });
    assert.equal(skipHooksOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'ask');
    assert.equal(skipHooksOf({ status: 'loaded', path: 'c.json', config: testConfig(), issues: [] }), 'deny');
    assert.equal(skipHooksOf({ status: 'missing', path: 'c.json' }), 'deny');
    assert.equal(skipHooksOf({ status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } }), 'deny');
    assert.equal(skipHooksOf(undefined), 'deny');
  });
});
