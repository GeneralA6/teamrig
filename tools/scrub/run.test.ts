import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { FakeGit } from '../lib/fake-git.ts';
import { GitError } from '../lib/git.ts';
import { GENERIC_RULES } from './rules.ts';
import { runScrub, type ScrubOptions } from './run.ts';
import type { ReadFile } from './sources.ts';

const INSIDE = 'rev-parse --is-inside-work-tree';
const CONFIG_GET = 'config --default  --get teamrig.scrubDenylist';
const NOTHING: ScrubOptions = { staged: false, tree: false, messageFile: undefined, range: undefined, denylistPath: undefined };

/** Runs inside a work tree unless `gitResponses` answers INSIDE otherwise. */
function harness(gitResponses: Readonly<Record<string, string | GitError>>, files: Readonly<Record<string, string>>) {
  const lines: string[] = [];
  const readFile: ReadFile = async (path) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });
    }
    return Buffer.from(content, 'utf8');
  };
  return { lines, deps: { git: new FakeGit({ [INSIDE]: 'true\n', ...gitResponses }), readFile, out: (line: string) => lines.push(line) } };
}

describe('runScrub', () => {
  it('refuses to run with nothing selected', async () => {
    const { deps, lines } = harness({}, {});
    assert.equal(await runScrub(NOTHING, deps), EXIT_USAGE);
    assert.match(lines.join('\n'), /nothing to scan/);
  });

  it('refuses outside a git work tree before reading any denylist, so it never passes on the generic rules alone', async () => {
    const notARepo = new GitError(['rev-parse', '--is-inside-work-tree'], 'fatal: not a git repository\n', new Error('exit 128'));
    const { deps, lines } = harness({ [INSIDE]: notARepo }, { MSG: 'ok\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_USAGE);
    assert.deepEqual(lines, [
      'scrub: not inside a git work tree, where git config teamrig.scrubDenylist names the private denylist; run it from inside the repo',
    ]);
    assert.deepEqual(deps.git.calls, [['rev-parse', '--is-inside-work-tree']]);
  });

  it('refuses inside a .git folder, which is no work tree', async () => {
    const { deps, lines } = harness({ [INSIDE]: 'false\n' }, { MSG: 'ok\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_USAGE);
    assert.match(lines.join('\n'), /^scrub: not inside a git work tree/);
  });

  it('passes a clean message with only the generic rules when no denylist is configured', async () => {
    const { deps, lines } = harness({ [CONFIG_GET]: '\n' }, { MSG: 'feat: add things\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_CLEAN);
    assert.match(lines.at(-1) ?? '', /^scrub: clean \(1 input\(s\), 0 binary skipped, \d+ generic \+ 0 private rule\(s\)\)$/);
  });

  it('applies the configured private denylist and reports each finding', async () => {
    const { deps, lines } = harness({ [CONFIG_GET]: 'deny.txt\n' }, { 'deny.txt': 'acme\n', MSG: 'fix: Acme bug\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_FINDINGS);
    assert.deepEqual(lines, [
      'commit message (MSG):1:6 denylist:1: private denylist term "Acme"',
      `scrub: 1 finding(s) (1 input(s), 0 binary skipped, ${GENERIC_RULES.length} generic + 1 private rule(s))`,
    ]);
  });

  it('prefers an explicit denylist path over git config', async () => {
    const { deps } = harness({}, { 'other.txt': 'bravo\n', MSG: 'bravo\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG', denylistPath: 'other.txt' }, deps), EXIT_FINDINGS);
  });

  it('fails closed when the configured denylist is missing', async () => {
    const { deps, lines } = harness({ [CONFIG_GET]: 'gone.txt\n' }, { MSG: 'ok\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_USAGE);
    assert.match(lines.join('\n'), /refusing to scan without it/);
  });

  it('fails closed when the configured denylist has no rules', async () => {
    const { deps } = harness({ [CONFIG_GET]: 'empty.txt\n' }, { 'empty.txt': '# nothing yet\n', MSG: 'ok\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_USAGE);
  });

  it('reports a malformed denylist as a usage error', async () => {
    const { deps, lines } = harness({ [CONFIG_GET]: 'bad.txt\n' }, { 'bad.txt': '(oops\n', MSG: 'ok\n' });
    assert.equal(await runScrub({ ...NOTHING, messageFile: 'MSG' }, deps), EXIT_USAGE);
    assert.match(lines.join('\n'), /denylist line 1/);
  });

  it('skips binary staged files but still scans their paths', async () => {
    const { deps, lines } = harness(
      {
        [CONFIG_GET]: '',
        'diff --cached --name-only -z --diff-filter=ACMR': 'logo.png\0',
        'show :logo.png': '\u0089PNG\u0000data',
      },
      {},
    );
    assert.equal(await runScrub({ ...NOTHING, staged: true }, deps), EXIT_CLEAN);
    assert.match(lines.at(-1) ?? '', /1 input\(s\), 1 binary skipped/);
  });
});
