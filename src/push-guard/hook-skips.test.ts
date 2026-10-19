import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { hookSkips } from './hook-skips.ts';
import { findGitInvocations, type ConfigValue, type GitConfigReader } from './invocations.ts';
import type { ShellDialect } from './tokenizer.ts';

/** Git config with `git ci` an alias of `git commit`; every other key unset. */
class AliasConfig implements GitConfigReader {
  config(_dir: string, key: string): ConfigValue {
    return key === 'alias.ci' ? { kind: 'set', value: 'commit' } : { kind: 'unset' };
  }
}

/** Each skip a line runs, as `subcommand|what turns the hooks off`. */
function skips(command: string, dialect: ShellDialect = 'bash'): string[] {
  const found = findGitInvocations(command, { cwd: resolve('/work/app'), home: '/u', dialect, git: new AliasConfig() });
  return hookSkips(found.invocations).map((skip) => `${skip.subcommand}|${skip.by}`);
}

function expectSkips(rows: readonly (readonly [string, readonly string[]])[], dialect: ShellDialect = 'bash'): void {
  for (const [command, expected] of rows) {
    assert.deepEqual(skips(command, dialect), expected, command);
  }
}

describe('hookSkips: options', () => {
  it('finds --no-verify, an abbreviation of it, and -n where it means --no-verify', () => {
    expectSkips([
      ['git commit --no-verify -m fix', ['commit|--no-verify']],
      ['git commit --no-ver -m fix', ['commit|--no-ver']],
      ['git commit -nm fix', ['commit|-n']],
      ['git commit -am fix -n', ['commit|-n']],
      ['git ci -n -m fix', ['commit|-n']],
      ['git push --no-verify origin feature', ['push|--no-verify']],
      ['git merge --no-verify feature', ['merge|--no-verify']],
      ['git pull --no-verify origin main', ['pull|--no-verify']],
      ['git rebase --no-verify main', ['rebase|--no-verify']],
      ['git am -n fix.patch', ['am|-n']],
      ['git send-email --no-verify fix.patch', ['send-email|--no-verify']],
    ]);
  });

  it('reads an option value as a value, -n where it means something else, and nothing after -- or --end-of-options', () => {
    expectSkips([
      ['git commit -m "--no-verify"', []],
      ['git commit -m -n', []],
      ['git commit --message --no-verify', []],
      ['git commit -F -n', []],
      ['git commit -m fix -- --no-verify', []],
      ['git commit --end-of-options --no-verify', []],
      ['git push -n origin main', []],
      ['git merge -n feature', []],
      ['git rebase -x "git status" -n main', []],
      ['git commit --no- -m fix', []],
      ['git commit --no-verify --verify -m fix', []],
      ['git commit -m "$MSG"', []],
      ['echo git commit --no-verify', []],
      ['git log --no-verify', []],
    ]);
  });
});

describe('hookSkips: overrides', () => {
  it('finds a husky switch or a core.hooksPath override set for git, for a shell that runs it, or earlier in its shell', () => {
    expectSkips([
      ['HUSKY=0 git commit -m fix', ['commit|HUSKY=0']],
      ['HUSKY_SKIP_HOOKS=1 git commit -m fix', ['commit|HUSKY_SKIP_HOOKS=1']],
      ['env HUSKY=0 git push origin feature', ['push|HUSKY=0']],
      ['HUSKY=$OFF git commit -m fix', ['commit|HUSKY=$OFF']],
      ['export HUSKY=0; git commit -m fix', ['commit|HUSKY set in its shell']],
      ['HUSKY=0 bash -c "git commit -m fix"', ['commit|HUSKY=0']],
      ['git -c core.hooksPath=/dev/null commit -m fix', ['commit|-c core.hooksPath=/dev/null']],
      ['git -c "$CFG" commit -m fix', ['commit|-c $CFG']],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m fix', ['commit|GIT_CONFIG_KEY_0=core.hooksPath']],
      ["GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m fix", ["commit|GIT_CONFIG_PARAMETERS='core.hooksPath'='/dev/null'"]],
      ['git -c core.hooksPath=/dev/null rebase -x "git commit --amend --no-edit" main', ['rebase|-c core.hooksPath=/dev/null', 'commit|-c core.hooksPath=/dev/null']],
    ]);
    expectSkips([["$env:HUSKY = '0'; git commit -m fix", ['commit|HUSKY set in its shell']]], 'powershell');
  });

  it('leaves husky on, another config key, a command that runs no hooks, and a setting a child shell keeps to itself', () => {
    expectSkips([
      ['HUSKY=1 git commit -m fix', []],
      ['HUSKY_SKIP_HOOKS= git commit -m fix', []],
      ['GIT_CONFIG_KEY_0=user.name git commit -m fix', []],
      ['git -c user.name=x commit -m fix', []],
      ['git -c core.hooksPath=/dev/null status', []],
      ['HUSKY=0 git status', []],
      ['HUSKY=0 bash -c "echo hi"; git commit -m fix', []],
      ['bash -c "export HUSKY=0"; git commit -m fix', []],
    ]);
  });
});

describe('hookSkips: git config', () => {
  it('finds a git config that sets or unsets core.hooksPath, in either form', () => {
    expectSkips([
      ['git config core.hooksPath /dev/null', ['config|git config core.hooksPath /dev/null']],
      ['git config --global core.hooksPath /tmp/none', ['config|git config core.hooksPath /tmp/none']],
      ['git config set core.hooksPath /dev/null', ['config|git config core.hooksPath /dev/null']],
      ['git config --unset core.hooksPath', ['config|git config --unset core.hooksPath']],
      ['git config unset core.hookspath', ['config|git config --unset core.hookspath']],
    ]);
  });

  it('leaves a read of it and a write of another key', () => {
    expectSkips([
      ['git config --get core.hooksPath', []],
      ['git config get core.hooksPath', []],
      ['git config core.hooksPath', []],
      ['git config user.name x', []],
      ['git config --unset user.name', []],
      ['git config "$KEY" /dev/null', []],
    ]);
  });
});
