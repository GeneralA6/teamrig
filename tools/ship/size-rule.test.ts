import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Load, type SizeRuleDeps, loadSizeRule, parseSizeRuleArgs, realSizeRuleDeps, runSizeRule } from './size-rule.ts';

const RULE = { maxLines: 400, maxFiles: 15 };

/** teamrig's three modules, by the end of their URL: two commits, one of them large unless `none`. */
function fakeLoad(options: { commits?: unknown; large?: unknown; text?: unknown; missing?: string } = {}): { load: Load; seen: { args: unknown[] }[] } {
  const seen: { args: unknown[] }[] = [];
  const commits = options.commits === undefined ? [{ sha: 'a' }, { sha: 'b', big: true }] : options.commits;
  const modules: Record<string, unknown> = {
    'push-guard/commit-size.ts': {
      largeCommits: (list: unknown, rule: unknown) => {
        seen.push({ args: [list, rule] });
        return options.large === undefined ? (Array.isArray(list) ? list.filter(commit => typeof commit === 'object' && commit !== null && 'big' in commit) : []) : options.large;
      },
      describeLargeCommits: (large: unknown) => (options.text === undefined ? `${Array.isArray(large) ? large.length : 0} large commit(s) need a Large-commit line` : options.text),
    },
    'push-guard/git.ts': { GIT_COMMIT_LOG: { between: (dir: unknown, base: unknown, tip: unknown) => (dir === 'C:/work' && base === 'origin/main' && tip === 'HEAD' ? commits : null) } },
    'config/defaults.ts': { DEFAULT_COMMITS: RULE },
  };
  const load: Load = async url => {
    const key = Object.keys(modules).find(path => url.endsWith(`/src/${path}`));
    if (key === undefined) throw new Error(`unexpected import ${url}`);
    return key === options.missing ? {} : modules[key];
  };
  return { load, seen };
}

function deps(load: Load): { deps: SizeRuleDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { deps: { cwd: 'C:/work', load, out: line => out.push(line), err: line => err.push(line) }, out, err };
}

test('reads the teamrig dir and an optional base', () => {
  assert.deepEqual(parseSizeRuleArgs(['--teamrig', '.']), { teamrig: '.', base: 'origin/main' });
  assert.deepEqual(parseSizeRuleArgs(['--base', 'main', '--teamrig', 'C:/t']), { teamrig: 'C:/t', base: 'main' });
  for (const argv of [[], ['--base', 'main'], ['--teamrig'], ['--teamrig', '--base'], ['--other', 'x']]) assert.throws(() => parseSizeRuleArgs(argv), /^Error: usage: size-rule\.ts --teamrig <teamrig dir>/);
});

test('fails on a large commit with no reason line, naming it, and passes when there is none', async () => {
  const failing = deps(fakeLoad().load);
  assert.equal(await runSizeRule(['--teamrig', 'C:/t'], failing.deps), 1);
  assert.deepEqual(failing.err, ['size rule: 1 large commit(s) need a Large-commit line']);

  const { load, seen } = fakeLoad({ commits: [{ sha: 'a' }] });
  const passing = deps(load);
  assert.equal(await runSizeRule(['--teamrig', 'C:/t'], passing.deps), 0);
  assert.deepEqual(passing.out, ['size rule: 1 commit(s) in origin/main..HEAD, none large']);
  assert.deepEqual(seen[0]?.args, [[{ sha: 'a' }], RULE], 'the rule is teamrig\'s own default');
});

test('fails when git cannot list the range or teamrig\'s modules are not what it reads', async () => {
  const unlisted = deps(fakeLoad({ commits: 'not a list' }).load);
  assert.equal(await runSizeRule(['--teamrig', 'C:/t'], unlisted.deps), 1);
  assert.deepEqual(unlisted.err, ['size rule: git cannot list the commits in origin/main..HEAD']);

  for (const [options, message] of [
    [{ missing: 'push-guard/commit-size.ts' }, /commit-size\.ts has no largeCommits\(\)/],
    [{ missing: 'push-guard/git.ts' }, /git\.ts has no GIT_COMMIT_LOG/],
    [{ missing: 'config/defaults.ts' }, /defaults\.ts has no DEFAULT_COMMITS/],
    [{ large: 'many' }, /largeCommits\(\) did not return a list/],
    [{ text: 3 }, /describeLargeCommits\(\) did not return text/],
  ] as const) {
    const run = deps(fakeLoad(options).load);
    assert.equal(await runSizeRule(['--teamrig', 'C:/t'], run.deps), 1);
    assert.match(run.err[0] ?? '', message);
  }
  const notModule = deps(async () => 'text');
  assert.equal(await runSizeRule(['--teamrig', 'C:/t'], notModule.deps), 1);
  assert.match(notModule.err[0] ?? '', /commit-size\.ts is not a module/);
  const usage = deps(fakeLoad().load);
  assert.equal(await runSizeRule([], usage.deps), 1);
  assert.match(usage.err[0] ?? '', /^usage: size-rule\.ts/);
  const thrown = deps(async () => {
    throw 'no such file';
  });
  assert.equal(await runSizeRule(['--teamrig', 'C:/t'], thrown.deps), 1);
  assert.deepEqual(thrown.err, ['no such file']);
});

test('imports the modules from the teamrig dir by default', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'size-rule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'push-guard'), { recursive: true });
  mkdirSync(join(dir, 'src', 'config'), { recursive: true });
  writeFileSync(join(dir, 'src', 'push-guard', 'commit-size.ts'), 'export const largeCommits = (list) => list.filter((c) => c.big);\nexport const describeLargeCommits = (large) => `${large.length} large`;\n');
  writeFileSync(join(dir, 'src', 'push-guard', 'git.ts'), "export const GIT_COMMIT_LOG = { between: () => [{ big: true }, {}] };\n");
  writeFileSync(join(dir, 'src', 'config', 'defaults.ts'), 'export const DEFAULT_COMMITS = { maxLines: 1 };\n');
  const rule = await loadSizeRule(dir);
  const commits = rule.between('C:/work', 'origin/main', 'HEAD') ?? [];
  assert.equal(rule.describe(rule.large(commits)), '1 large');
});

test('the real deps read the current folder and print to the console', async t => {
  const log = t.mock.method(console, 'log', () => undefined);
  const error = t.mock.method(console, 'error', () => undefined);
  const real = realSizeRuleDeps();
  assert.equal(real.cwd, process.cwd());
  real.out('o');
  real.err('e');
  assert.deepEqual([log.mock.calls[0]?.arguments, error.mock.calls[0]?.arguments], [['o'], ['e']]);
  assert.ok(typeof (await real.load('node:path')) === 'object');
});
