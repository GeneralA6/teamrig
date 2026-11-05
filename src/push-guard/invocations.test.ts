import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { configWrite, findGitInvocations, shellVariables, type ConfigValue, type GitConfigReader, type GitInvocations } from './invocations.ts';
import { parseShell, type ShellDialect, type ShellWord } from './tokenizer.ts';

/** A resolved start folder, as the hook gives one. */
const CWD = resolve('/work/app');

/** Git config with these aliases; `alias.broken` cannot be read. Records every read. */
class FakeConfig implements GitConfigReader {
  readonly reads: string[] = [];
  private readonly values: ReadonlyMap<string, string>;

  constructor(values: Readonly<Record<string, string>>) {
    this.values = new Map(Object.entries(values));
  }

  config(dir: string, key: string): ConfigValue {
    this.reads.push(`${dir}:${key}`);
    if (key === 'alias.broken') {
      return { kind: 'unreadable' };
    }
    const value = this.values.get(key);
    return value === undefined ? { kind: 'unset' } : { kind: 'set', value };
  }
}

const ALIASES = {
  'alias.p': 'push origin main',
  'alias.sp': '!git push origin main',
  'alias.loop': 'loop',
  'alias.fwd': 'p',
  'alias.cd2': '!cd sub && git status',
};

function find(command: string, dialect: ShellDialect = 'bash', git: GitConfigReader = new FakeConfig(ALIASES)): GitInvocations {
  return findGitInvocations(command, { cwd: CWD, home: '/u', dialect, git });
}

const show = (word: ShellWord): string => (word.dynamic ? `~${word.text}` : word.text);

/** Each invocation as `dir|subcommand|args`, with `|cfg` when config is overridden; `?` for an unknown folder. */
function invocations(command: string, dialect: ShellDialect = 'bash'): string[] {
  return find(command, dialect).invocations.map(
    (found) => `${found.dir ?? '?'}|${found.subcommand}|${found.args.map(show).join(' ')}${found.configOverride ? '|cfg' : ''}`,
  );
}

/** Each doubt as its reason, prefixed `g:` when gated on a push and `!:` when it always asks. */
function doubts(command: string, dialect: ShellDialect = 'bash'): string[] {
  return find(command, dialect).doubts.map((doubt) => `${doubt.gated ? 'g' : '!'}:${doubt.reason}`);
}

function expectInvocations(rows: readonly (readonly [string, readonly string[]])[], dialect: ShellDialect = 'bash'): void {
  for (const [command, expected] of rows) {
    assert.deepEqual(invocations(command, dialect), expected, command);
    assert.deepEqual(doubts(command, dialect), [], command);
  }
}

function expectDoubt(command: string, expected: string, dialect: ShellDialect = 'bash'): void {
  assert.deepEqual(doubts(command, dialect), [expected], command);
}

const SUB = resolve(CWD, 'sub');

describe('findGitInvocations: global options', () => {
  it('reads -C, --git-dir and their folders', () => {
    expectInvocations([
      ['git status', [`${CWD}|status|`]],
      ['git -C sub push origin main', [`${SUB}|push|origin main`]],
      ['git -C "$D" push', ['?|push|']],
      ["git -C '' push", [`${CWD}|push|`]],
      ['git --git-dir=../o/.git push', [`${resolve(CWD, '../o/.git')}|push|`]],
      ['git -C sub --git-dir=.git push', [`${resolve(SUB, '.git')}|push|`]],
      ['git --git-dir="$G" push', ['?|push|']],
      ['git --namespace x push', [`${CWD}|push|`]],
      ['git --exec-path=/x push', [`${CWD}|push|`]],
    ]);
  });

  it('marks config overrides that may change where a push goes', () => {
    expectInvocations([
      ['git -c push.default=matching push', [`${CWD}|push||cfg`]],
      ['git -c user.name=x push', [`${CWD}|push|`]],
      ['git -c "$K" push', [`${CWD}|push||cfg`]],
    ]);
  });

  it('runs nothing for an informational option or a missing value', () => {
    expectInvocations([
      ['git --version push', []],
      ['git --help', []],
      ['git -c', []],
    ]);
  });

  it('doubts a subcommand only known when it runs', () => {
    for (const command of ['git "$SUB" origin main', 'git --"$X" push', 'git "$OPT" push']) {
      expectDoubt(command, 'g:the git command it runs is only known when it runs');
    }
  });
});

describe('findGitInvocations: aliases', () => {
  it('expands -c aliases, including shell aliases and any case', () => {
    expectInvocations([
      ["git -c alias.q='push origin main' q", [`${CWD}|push|origin main`]],
      ["git -c 'alias.q=!git push origin main' q", [`${CWD}|push|origin main`]],
      ['git -c alias.Q=status q', [`${CWD}|status|`]],
    ]);
  });

  it('expands config aliases, chained and shell ones, in the folder they run in', () => {
    expectInvocations([
      ['git p', [`${CWD}|push|origin main`]],
      ['git fwd', [`${CWD}|push|origin main`]],
      ['git sp', [`${CWD}|push|origin main`]],
      ['git cd2', [`${SUB}|status|`]],
      ['git nothere', []],
    ]);
    const git = new FakeConfig(ALIASES);
    find('git -C sub p', 'bash', git);
    assert.deepEqual(git.reads, [`${SUB}:alias.p`]);
  });

  it('expands an alias set earlier in the line', () => {
    expectInvocations([
      ["git config alias.q 'push origin main' && git q", [`${CWD}|config|alias.q push origin main`, `${CWD}|push|origin main`]],
      ["git config set alias.q 'push origin main' && git q", [`${CWD}|config|set alias.q push origin main`, `${CWD}|push|origin main`]],
      ["git config -f x alias.q 'push' && git q", [`${CWD}|config|-f x alias.q push`, `${CWD}|push|`]],
      ['git config alias.Q status && git q', [`${CWD}|config|alias.Q status`, `${CWD}|status|`]],
      ['git config --get alias.q && git q', [`${CWD}|config|--get alias.q`]],
      ['git config get alias.q && git q', [`${CWD}|config|get alias.q`]],
      ['git config --unset alias.q x && git q', [`${CWD}|config|--unset alias.q x`]],
      ['git config alias.q', [`${CWD}|config|alias.q`]],
    ]);
  });

  it('doubts an alias it cannot read', () => {
    expectDoubt('git -c "alias.q=$X" q', 'g:"git q" is an alias whose value is only known when it runs');
    expectDoubt('git --config-env=alias.q=ENV q', 'g:"git q" is an alias whose value is only known when it runs');
    expectDoubt('git config alias.q "$V" && git q', 'g:"git q" is an alias whose value is only known when it runs');
    expectDoubt('git -c core.x=1 -c "$K" zz', 'g:"git zz" may be an alias a config override sets');
    expectDoubt('cd "$D" && git nothere', 'g:"git nothere" may be an alias of a repository only known when it runs');
    expectDoubt('git broken', '!:git could not read whether "git broken" is an alias');
    expectDoubt('git loop', '!:git aliases nest too deep to read');
  });
});

describe('findGitInvocations: commands git runs', () => {
  it('reads submodule foreach, rebase --exec, bisect run and filter-branch filters', () => {
    expectInvocations([
      ["git submodule foreach 'git push'", [`${CWD}|submodule|foreach git push`, '?|push|']],
      ['git submodule --quiet foreach --recursive git push origin main', [`${CWD}|submodule|--quiet foreach --recursive git push origin main`, '?|push|origin main']],
      ['git submodule foreach', [`${CWD}|submodule|foreach`]],
      ['git submodule update', [`${CWD}|submodule|update`]],
      ["git rebase -x 'git push' main", [`${CWD}|rebase|-x git push main`, `${CWD}|push|`]],
      ["git rebase --exec='git push' main", [`${CWD}|rebase|--exec=git push main`, `${CWD}|push|`]],
      ['git rebase -xgit\\ push main', [`${CWD}|rebase|-xgit push main`, `${CWD}|push|`]],
      ['git bisect run git push', [`${CWD}|bisect|run git push`, `${CWD}|push|`]],
      ['git bisect run', [`${CWD}|bisect|run`]],
      ["git filter-branch --tree-filter 'git push' HEAD", [`${CWD}|filter-branch|--tree-filter git push HEAD`, '?|push|']],
    ]);
  });

  it('reads git-<builtin> programs, and no git extension', () => {
    expectInvocations([
      ['git-push origin main', [`${CWD}|push|origin main`]],
      ['git-foo', []],
    ]);
  });
});

describe('findGitInvocations: variables', () => {
  it('moves git by GIT_DIR and overrides config by GIT_CONFIG*', () => {
    expectInvocations([
      ['GIT_DIR=../o/.git git push', [`${resolve(CWD, '../o/.git')}|push|`]],
      ['GIT_DIR="$G" git push', ['?|push|']],
      ['GIT_COMMON_DIR=x git push', ['?|push|']],
      ['GIT_CONFIG_GLOBAL=x git push', [`${CWD}|push||cfg`]],
    ]);
  });

  it('treats a variable set in the shell earlier in the line as unknown', () => {
    expectInvocations([
      ['export GIT_DIR=x; git push', ['?|push|']],
      ['GIT_DIR=x; git push', ['?|push|']],
      ['export GIT_CONFIG_COUNT=1; git status', [`${CWD}|status||cfg`]],
    ]);
    expectInvocations([["$env:GIT_DIR = 'x'; git push", ['?|push|']]], 'powershell');
    expectInvocations([['set GIT_DIR=x& git push', ['?|push|']]], 'cmd');
  });
});

describe('findGitInvocations: scripts and shells', () => {
  it('follows folders a same-shell script moves, and no nested shell', () => {
    expectInvocations([
      ["eval 'cd sub'; git push", [`${SUB}|push|`]],
      ["bash -c 'cd sub'; git push", [`${CWD}|push|`]],
      ['env -C sub git push', [`${SUB}|push|`]],
      [`${'eval '.repeat(8)}git push`, [`${CWD}|push|`]],
    ]);
  });

  it('marks arguments read from stdin, and reads a heredoc or here-string only when a shell runs it', () => {
    expectInvocations([
      ['xargs git push < x', [`${CWD}|push|~<stdin>`]],
      ['cat <<EOF\ngit push\nEOF', []],
      ['bash <<EOF\ngit push\nEOF', [`${CWD}|push|`]],
      ["bash <<'EOF'\ncd sub\nEOF\ngit push", [`${CWD}|push|`]],
      ['bash <<< "git push"', [`${CWD}|push|`]],
      ["pwsh -Command - <<'EOF'\ngit push\nEOF", [`${CWD}|push|`]],
      ['cmd <<EOF\ngit push\nEOF', [`${CWD}|push|`]],
    ]);
  });

  it('hands a heredoc down a pipe only through a plain cat', () => {
    expectInvocations([
      ['cat <<EOF | bash\ngit push\nEOF', [`${CWD}|push|`]],
      ['cat - <<EOF |& bash -s\ngit push\nEOF', [`${CWD}|push|`]],
      ['cat <<EOF | bash -s $(echo x)\ngit push\nEOF', [`${CWD}|push|`]],
    ]);
    for (const line of [
      'cat <<EOF | tee x | bash\ngit push\nEOF',
      'cat <<EOF > /dev/stdout | bash\ngit push\nEOF',
      'cat x <<EOF | bash\ngit push\nEOF',
      'cat <<EOF; bash\ngit push\nEOF',
      'cat <<EOF | bash < x.sh\ngit push\nEOF',
      'bash < x.sh',
      'xargs bash <<EOF\ngit push\nEOF',
    ]) {
      expectDoubt(line, 'g:a shell reads its commands from stdin');
    }
  });

  it('doubts a push held in quoted text, and reads a substitution a shell runs as commands', () => {
    const held = 'g:it holds a quoted command substitution that pushes, which bash runs if an expansion reads it again';
    // bash expands held text left to right, so a push before the point where it never closes still runs.
    for (const line of ["x='$(git push origin main)'; echo ${x@P}", "x='a[$(git push)]'; echo $((x))", "export X='`git push`'", "echo 'a[$(git p)]'", 'x="a[\\$(git push)]"; let y=x', "echo '$(git push) $('"]) {
      expectDoubt(line, held);
    }
    expectDoubt("echo '$(git $SUB)'", 'g:the git command it runs is only known when it runs');
    expectDoubt(`echo "\\\${x:-'\\$(git push)'}"`, 'g:it holds quoted text the guard cannot read for the commands bash runs if an expansion reads it again');
    expectInvocations([
      [`grep -n "^##\\|push(\\\`##\\|'## " file`, []],
      ["echo '$(git status'", []],
      ["git commit -m 'run $(git status) first'", [`${CWD}|commit|-m run $(git status) first`]],
      ["bash -c 'echo $(git push origin feat)'", [`${CWD}|push|origin feat`]],
      ["eval 'echo $(git push)'", [`${CWD}|push|`]],
      ['echo "$(git push)"', [`${CWD}|push|`]],
    ]);
  });

  it('doubts what it cannot read', () => {
    expectDoubt('bash -c "$CMD"', 'g:the program it runs is only known when it runs');
    expectDoubt('pwsh -c "$CMD"', 'g:it hands PowerShell a command line built from bash variables');
    expectDoubt('echo "unclosed', 'g:part of it cannot be read, as a quote, bracket or substitution never closes');
    expectDoubt('echo "a`0b', 'g:part of it cannot be read, as a quote, bracket or substitution never closes', 'powershell');
    expectDoubt('echo a`0b', "g:its words differ by the shell's version, its host or how it is started", 'powershell');
    expectDoubt('echo "a`u{2d}b"', "g:its words differ by the shell's version, its host or how it is started", 'powershell');
    expectDoubt('echo a\rb', "g:its words differ by the shell's version, its host or how it is started");
    expectDoubt('echo a^\nb', "g:its words differ by the shell's version, its host or how it is started", 'cmd');
    expectDoubt(`${'eval '.repeat(9)}git push`, '!:scripts nest too deep to read');
  });

  it('says whether a word the line runs, or a script, alias or heredoc it reads, names a push', () => {
    const mentions = (command: string): boolean => find(command).mentionsPush;
    const named = ['echo push', 'git p', 'x --push', 'git-push.exe x', 'X=push; y', 'cat <<EOF | bash\npush\nEOF', 'cat <<EOF\npush\nEOF', 'cat <<A <<B\npush\nA\nB', 'echo "unclosed push'];
    assert.deepEqual(named.map(mentions), new Array<boolean>(named.length).fill(true));
    const unnamed = [
      'git status',
      'git -c alias.Q=status q',
      'wc -l src/push-guard/*.ts',
      'tail x-push.log',
      'echo ok # push',
      'echo done > push.log',
      "cat >> notes.md <<'EOF'\nthe push is done\nEOF",
      'cat > /tmp/n - <<EOF\npush\nEOF',
    ];
    assert.deepEqual(unnamed.map(mentions), new Array<boolean>(unnamed.length).fill(false));
  });
});

describe('shellVariables', () => {
  const variables = (line: string, dialect: ShellDialect): string[] => shellVariables(parseShell(line, dialect).commands[0]?.words ?? [], dialect);

  it('reads bash setters and bare assignments, not a program prefix', () => {
    assert.deepEqual(variables('export A=1 B=2 C', 'bash'), ['A', 'B']);
    assert.deepEqual(variables('A=1 B=2', 'bash'), ['A', 'B']);
    assert.deepEqual(variables('A=1 echo', 'bash'), []);
    assert.deepEqual(variables('echo A=1', 'bash'), []);
    assert.deepEqual(shellVariables([], 'bash'), []);
  });

  it('reads PowerShell env assignments and env: items', () => {
    assert.deepEqual(variables('$env:X = 1', 'powershell'), ['X']);
    assert.deepEqual(variables('$env:X=1', 'powershell'), ['X']);
    assert.deepEqual(variables('$env:X += 1', 'powershell'), ['X']);
    assert.deepEqual(variables('$env:X', 'powershell'), []);
    assert.deepEqual(variables('Set-Item env:X 1', 'powershell'), ['X']);
    assert.deepEqual(variables('ni env:\\Y 1', 'powershell'), ['Y']);
    assert.deepEqual(variables('Set-Item foo 1', 'powershell'), []);
  });

  it("reads cmd's set", () => {
    assert.deepEqual(variables('set X=1', 'cmd'), ['X']);
    assert.deepEqual(variables('echo X=1', 'cmd'), []);
  });
});

describe('configWrite', () => {
  /** What `git config <args>` writes, as `set key value`, `unset key` or `none`. */
  const write = (line: string): string => {
    const found = configWrite(parseShell(line, 'bash').commands[0]?.words.slice(2) ?? []);
    if (found === undefined) {
      return 'none';
    }
    return found.kind === 'set' ? `set ${show(found.key)} ${show(found.value)}` : `unset ${show(found.key)}`;
  };

  it('reads a set or an unset in either form, past the options and their values', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['git config alias.q status', 'set alias.q status'],
      ['git config --global -f x --type=bool core.hooksPath /dev/null', 'set core.hooksPath /dev/null'],
      ['git config --file=x alias.q push', 'set alias.q push'],
      ["git config set --global alias.q 'push origin'", 'set alias.q push origin'],
      ['git config "$K" v', 'set ~$K v'],
      ['git config --unset core.hooksPath', 'unset core.hooksPath'],
      ['git config --unset-all alias.q x', 'unset alias.q'],
      ['git config unset --global core.hooksPath', 'unset core.hooksPath'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(write(line), expected, line);
    }
  });

  it('reads none for a read, an edit, a section change or a line with no key or value', () => {
    for (const line of ['git config --get alias.q', 'git config get alias.q', 'git config --list', 'git config list', 'git config edit', 'git config --rename-section a b', 'git config alias.q', 'git config', 'git config unset']) {
      assert.equal(write(line), 'none', line);
    }
  });
});

describe('findGitInvocations: hooks overrides', () => {
  const overrides = (command: string): (string | undefined)[] => find(command).invocations.map((found) => found.hooksOverride);

  it('records what may turn the hooks off on every git run it reaches, hooked or not, and nothing on a plain one', () => {
    assert.deepEqual(overrides('HUSKY=0 git status'), ['HUSKY=0']);
    assert.deepEqual(overrides('git -c core.hooksPath=x status && git status'), ['-c core.hooksPath=x', undefined]);
    assert.deepEqual(overrides('git --config-env=core.hooksPath=H status'), ['--config-env core.hooksPath=H']);
    assert.deepEqual(overrides('export HUSKY_SKIP_HOOKS=1; git status; git log'), ['HUSKY_SKIP_HOOKS set in its shell', 'HUSKY_SKIP_HOOKS set in its shell']);
    assert.deepEqual(overrides('HUSKY=0 git sp'), ['HUSKY=0'], 'a shell alias stands for the git it runs, which keeps the override');
    assert.deepEqual(overrides('HUSKY=1 git status; git -c user.name=x status'), [undefined, undefined]);
  });
});
