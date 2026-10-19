import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { programReads, type ProgramArgument } from './programs.ts';

/** A static argument, as written. */
const fixed = (text: string): ProgramArgument => ({ text, dynamic: false, single: true });
/** A quoted variable (`"$x"`): one argument, its text unknown. */
const quoted = (text: string): ProgramArgument => ({ text, dynamic: true, single: true });
/** An unquoted variable or glob (`$x`, `*.ts`): any number of arguments, their text unknown. */
const spread = (text: string): ProgramArgument => ({ text, dynamic: true, single: false });
/** An unquoted glob of one-character brackets (`a[0]`): its text, or the one file it may match. */
const bracketed = (text: string, bracketMatch: string): ProgramArgument => ({ text, dynamic: true, single: false, bracketMatch });

const reads = (program: string, ...texts: string[]): boolean => programReads(program, texts.map(fixed));

/** Asserts each argument list of `program` reads (`expected` true) or not, naming the list on failure. */
function expectAll(program: string, lists: readonly (readonly string[])[], expected: boolean): void {
  for (const list of lists) {
    assert.equal(reads(program, ...list), expected, `${program} ${list.join(' ')}`);
  }
}

describe('programReads', () => {
  it('refuses a program it does not know', () => {
    for (const program of ['rm', 'find', 'curl', 'npx', 'node', 'xargs', 'env']) {
      assert.equal(reads(program, 'x'), false, program);
    }
  });

  it('lets the plain readers take any arguments, variables and globs too', () => {
    expectAll('grep', [['-rn', 'x', 'src'], ['-f', 'patterns', 'file']], true);
    expectAll('cat', [[], ['a', 'b']], true);
    assert.equal(programReads('cat', [spread('$files'), spread('*.ts')]), true);
    assert.equal(programReads('echo', [quoted('$x')]), true);
  });

  describe('sed', () => {
    it('prints line ranges, regex ranges and several print commands', () => {
      expectAll(
        'sed',
        [
          ['-n', '1,45p', 'f'],
          ['-n', '10,+5p', 'f'],
          ['-n', '/private async load/,/^  }/p', 'f'],
          ['-n', '/start/p', 'f'],
          ['-n', String.raw`/a\/b/,/end/p`, 'f'],
          ['-n', '/x; y/p', 'f'],
          ['-n', '/first/p;/second/p', 'f'],
          ['-n', '/start/,+5p', 'f'],
          ['-n', 'p', 'f'],
          ['-e', '1p', 'f'],
          ['--quiet', '-E', '$p'],
          ['-n', '--', '1p', 'f'],
          ['-n', '1p', '-'],
        ],
        true,
      );
    });

    it('refuses editing, writing, running and any script it cannot read', () => {
      expectAll(
        'sed',
        [
          ['-i', 's/a/b/', 'f'],
          ['-n', '1p', '-i', 'f'],
          ['-n', 'w evil.txt', 'f'],
          ['-n', 's/a/b/p', 'f'],
          ['-n', '/x/w evil.txt', 'f'],
          ['-n', '/x/e rm -rf /', 'f'],
          ['-n', '/x/,/y/d', 'f'],
          ['-n', '/x/p;w evil.txt', 'f'],
          ['-n', '/x/pw evil.txt', 'f'],
          ['-n', '/unterminated/,/y', 'f'],
          ['-n', '/x/I p', 'f'],
          ['-n'],
          ['-e'],
          ['-e', '1p', '-e', '2p', 'f'],
        ],
        false,
      );
    });

    it('refuses a script or an option a variable decides', () => {
      assert.equal(programReads('sed', [fixed('-n'), quoted('$script'), fixed('f')]), false);
      assert.equal(programReads('sed', [spread('$opts'), fixed('1p'), fixed('f')]), false);
    });
  });

  describe('awk', () => {
    it('runs a plain print program after -F and -v', () => {
      expectAll(
        'awk',
        [
          ['{print $1, $2}', 'file.txt'],
          ['-F:', '{print $1}', '/etc/passwd'],
          ['-F', ':', '{print}'],
          ['-v', 'x=1', '{print NR}'],
          ['--', '{print NF}'],
          ['{print;}', 'f'],
        ],
        true,
      );
    });

    it('refuses programs that run, write or loop, program files and dangling options', () => {
      expectAll(
        'awk',
        [
          ['{system("rm -rf /")}', 'f'],
          ['{print > "evil.txt"}', 'f'],
          ['-f', 'prog.awk', 'f'],
          ['BEGIN{while(1)print}', 'f'],
          ['{print $(system("rm x"))}', 'f'],
          ['-i', 'inplace', '{print}', 'f'],
          ['-F'],
          [],
        ],
        false,
      );
    });

    it('refuses a program or an option value a variable decides', () => {
      assert.equal(programReads('awk', [quoted('$program'), fixed('f')]), false);
      assert.equal(programReads('awk', [fixed('-F'), quoted('$separator'), fixed('{print}')]), false);
      assert.equal(programReads('awk', [quoted('$option'), fixed('{print}')]), false);
    });
  });

  describe('sort', () => {
    it('sorts to the screen, a file named -o after -- included', () => {
      expectAll('sort', [['-u', 'f'], ['-k2', '-n', 'f'], ['--', '-o']], true);
    });

    it('refuses an output file, alone, abbreviated or in a cluster, and a compressor', () => {
      expectAll('sort', [['-o', 'out', 'in'], ['--output=out', 'in'], ['--out=x', 'in'], ['-uo', 'out', 'in'], ['--compress-program=gzip', 'in']], false);
      assert.equal(programReads('sort', [spread('$opts'), fixed('in')]), false);
    });
  });

  describe('test and [', () => {
    it('compares and checks files', () => {
      expectAll('test', [[], ['x'], ['-f', 'file.ts'], ['a', '=', 'b'], ['-n', 'a', '-a', '-f', 'b']], true);
      assert.equal(programReads('test', [fixed('-z'), quoted('$x')]), true);
      assert.equal(programReads('test', [quoted('$rc'), fixed('!='), fixed('0')]), true);
      assert.equal(programReads('[', [fixed('-z'), quoted('$x'), fixed(']')]), true);
    });

    it('refuses -v and -R, which evaluate a subscript, and any value that could become them', () => {
      expectAll('test', [['-v', 'a[$(rm x)]'], ['-R', 'name']], false);
      assert.equal(programReads('test', [spread('$x')]), false);
      assert.equal(programReads('test', [quoted('$x'), fixed('name')]), false);
      assert.equal(programReads('test', [fixed('a'), quoted('$operator'), fixed('b')]), false);
      assert.equal(programReads('test', [fixed('a'), fixed('-nt'), fixed('b'), fixed('-o'), quoted('$x')]), false);
    });

    it('needs the closing ] after [', () => {
      expectAll('[', [['-z', 'x'], []], false);
    });
  });

  describe('git', () => {
    it('runs a reading subcommand after --no-pager, -P and -C', () => {
      expectAll(
        'git',
        [
          ['status'],
          ['-C', 'C:/repo', 'log', '--oneline', '-5'],
          ['--no-pager', 'diff', 'HEAD~1', '--', 'src/file.ts'],
          ['-P', 'show', 'HEAD:src/file.ts'],
          ['grep', '-n', 'x', '--', '*.ts'],
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          ['blame', '-L', '10,20', 'f'],
          ['diff', '--stat'],
          ['diff', '--', '--output=x'],
        ],
        true,
      );
      assert.equal(programReads('git', [fixed('-C'), quoted('$repo'), fixed('status')]), true);
    });

    it('refuses writing subcommands, config and exec overrides, file output, external diff and pagers', () => {
      expectAll(
        'git',
        [
          ['add', '-A'],
          ['commit', '-m', 'x'],
          ['checkout', 'main'],
          ['push', 'origin', 'main'],
          ['branch', 'new-branch'],
          ['stash'],
          ['reflog', 'expire', '--all'],
          ['-c', 'diff.external=rm -rf /', 'diff'],
          ['--exec-path=/evil', 'diff'],
          ['diff', '--output=/tmp/evil.txt'],
          ['log', '--output', 'evil.txt'],
          ['log', '--out=evil.txt'],
          ['diff', '--ext-diff'],
          ['grep', '-O"rm -rf /"', 'pattern'],
          ['grep', '-niO', 'pattern'],
          ['grep', '--open-files-in-pager', 'pattern'],
          ['-C'],
          [],
        ],
        false,
      );
    });

    it('refuses a subcommand, folder or option a variable decides', () => {
      assert.equal(programReads('git', [quoted('$command')]), false);
      assert.equal(programReads('git', [fixed('-C'), spread('$repo'), fixed('status')]), false);
      assert.equal(programReads('git', [fixed('diff'), spread('$opts')]), false);
    });
  });

  describe('kubectl', () => {
    it('runs a reading command, with config and rollout read subcommands', () => {
      expectAll(
        'kubectl',
        [
          ['get', 'pods', '-n', 'app'],
          ['logs', '-n', 'app', 'worker-abc', '--since=6m'],
          ['describe', 'deploy/api', '-n', 'app'],
          ['top', 'pods'],
          ['config', 'current-context'],
          ['rollout', 'status', 'deploy/worker'],
          ['get', 'pods', '-A', '-o', 'wide'],
          ['get', 'pods', '-Ao', 'wide'],
          ['get', 'pods', '--no-headers'],
          ['cluster-info'],
        ],
        true,
      );
    });

    it('refuses writes, exec, a leading flag, secrets, credentials and another server', () => {
      expectAll(
        'kubectl',
        [
          ['delete', 'pod', 'x'],
          ['apply', '-f', 'deploy.yaml'],
          ['exec', '-n', 'app', 'pod', '--', 'psql', '-c', 'select 1'],
          ['scale', 'deploy/x', '--replicas=0'],
          ['rollout', 'restart', 'deploy/x'],
          ['config', 'use-context', 'prod'],
          ['config', 'set-context', 'x', '--namespace=y'],
          ['config'],
          ['-n', 'app', 'logs', 'pod-x'],
          ['get', 'secrets'],
          ['get', 'Secret/db'],
          ['config', 'view', '--raw'],
          ['config', 'view', '--flatten'],
          ['get', 'pods', '--kubeconfig=/tmp/x'],
          ['get', 'pods', '--server', 'https://elsewhere'],
          ['get', 'pods', '--token=abc'],
          ['get', 'pods', '-s', 'https://elsewhere'],
          ['get', 'pods', '-As', 'https://elsewhere'],
          ['logs', 'pod', '--log-file=/tmp/x'],
          ['cluster-info', 'dump'],
          [],
        ],
        false,
      );
    });

    it('refuses any argument a variable decides', () => {
      assert.equal(programReads('kubectl', [quoted('$command')]), false);
      assert.equal(programReads('kubectl', [fixed('config'), quoted('$sub')]), false);
      assert.equal(programReads('kubectl', [fixed('get'), fixed('pod'), quoted('$pod')]), false);
    });

    it('takes a bracket glob as an option value only when both texts it may reach kubectl as read', () => {
      const columns = 'custom-columns=IMG:.spec.containers[0].image';
      assert.equal(programReads('kubectl', [fixed('get'), fixed('pods'), fixed('-o'), bracketed(columns, columns.replace('[0]', '0'))]), true);
      assert.equal(programReads('kubectl', [fixed('get'), fixed('pods'), bracketed('x[0]', '--token=x')]), false);
      assert.equal(programReads('kubectl', [fixed('get'), fixed('secret[0]'), bracketed('a', 'a')]), false);
      assert.equal(programReads('kubectl', [bracketed('ge[*]', 'get'), fixed('pods')]), false);
    });
  });
});
