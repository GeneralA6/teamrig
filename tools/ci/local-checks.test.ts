import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRecord } from '../lib/guards.ts';
import { DEFAULT_BASE, changedSpecs, gateChanges, localChecks, prePushChecks, shortChecks } from './local-checks.ts';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** The npm scripts of the workspace. */
function npmScripts(): ReadonlyMap<string, string> {
  const pkg: unknown = JSON.parse(read('package.json'));
  assert.ok(isRecord(pkg));
  const scripts = pkg['scripts'];
  assert.ok(isRecord(scripts));
  return new Map(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The commands CI runs, with each `npm run <script>` replaced by the script's `&&`-separated commands. */
function ciCommands(): string[] {
  const scripts = npmScripts();
  const runs = [...read('.github/workflows/ci.yml').matchAll(/^\s*- run: (.+)$/gm)].map((match) => (match[1] ?? '').trim());
  assert.ok(runs.length > 0, 'ci.yml lists no commands');
  return runs.flatMap((command) => {
    const script = /^npm run (\S+)$/.exec(command)?.[1];
    if (script === undefined) return [command];
    const body = scripts.get(script);
    assert.ok(body !== undefined, `CI runs the npm script ${script}, which package.json lacks`);
    return body.split('&&').map((part) => part.trim());
  });
}

describe('localChecks', () => {
  const checks = localChecks(DEFAULT_BASE);
  const argvs = checks.map((check) => check.argv.join(' '));

  it('runs every command CI runs', () => {
    for (const command of ciCommands()) {
      if (command.startsWith('npm ci')) continue; // installing is the developer's setup
      const script = /^node (\S+\.ts)/.exec(command)?.[1];
      const tsc = /^tsc (.+)$/.exec(command)?.[1];
      if (script !== undefined) assert.ok(argvs.some((argv) => argv.startsWith(`node ${script}`)), `no local check runs ${script}`);
      else if (tsc !== undefined) assert.ok(argvs.includes(`node node_modules/typescript/bin/tsc ${tsc}`), `no local check runs tsc ${tsc}`);
      else if (command === 'npm test') assert.ok(argvs.includes('node tools/ci/coverage-cli.ts'), 'the coverage gate runs the tests');
      // A docs change's job runs a few specs (T4617); the coverage gate runs every spec.
      else if (command.startsWith('node --test ')) assert.ok(argvs.includes('node tools/ci/coverage-cli.ts'), `the coverage gate runs the specs of \`${command}\``);
      else assert.fail(`CI runs \`${command}\`, which no local check covers: add it to local-checks.ts`);
    }
  });

  it("runs the plugin's own tests after the build, in an empty home", () => {
    const at = checks.findIndex((check) => check.name === 'plugin tests');
    assert.deepEqual(checks[at], { name: 'plugin tests', argv: ['claude', 'plugin', 'test', 'plugins/teamrig'], isolatedHome: true });
    assert.ok(at > checks.findIndex((check) => check.name === 'build: compile'), 'the mod loads the built dist');
  });

  it('builds the plugin before the coverage gate, whose specs load the built dist (T4355)', () => {
    const at = (name: string): number => checks.findIndex((check) => check.name === name);
    assert.ok(at('build: integrity') >= 0 && at('build: integrity') < at('coverage gate'));
  });

  it('checks the commits since the base, names each check once and reads no CI event', () => {
    assert.deepEqual(localChecks('upstream/main').find((check) => check.name === 'DCO')?.argv, ['node', 'tools/dco/cli.ts', '--range', 'upstream/main..HEAD']);
    assert.equal(new Set(checks.map((check) => check.name)).size, checks.length);
    assert.ok(argvs.every((argv) => !argv.includes('--github')));
  });
});

describe('prePushChecks (T4344)', () => {
  const full = new Map(localChecks('upstream/main').map((check) => [check.name, check]));
  const checks = prePushChecks('upstream/main');

  it('runs the scrubs, the commit checks, the typecheck, the boundaries, the build, the plugin tests and the docs checks, in that order', () => {
    assert.deepEqual(
      checks.map((check) => check.name),
      ['scrub: tree', 'scrub: commits', 'DCO', 'size rule', 'commit subjects', 'typecheck', 'boundaries', 'build: clean', 'build: compile', 'build: integrity', 'plugin tests', 'doc pictures', 'doc config reference', 'doc parity page', 'doc links'],
    );
  });

  it('takes each check from the full list as it is', () => {
    for (const check of checks) assert.deepEqual(check, full.get(check.name), check.name);
  });

  it("builds the dist before the plugin's tests, which load it, as main tracks none (T4595)", () => {
    const at = (name: string): number => checks.findIndex((check) => check.name === name);
    assert.ok(at('build: integrity') >= 0 && at('build: integrity') < at('plugin tests'));
    assert.ok(checks.every((check) => !check.argv.includes('--noEmit')), 'a compile that emits nothing leaves a fresh checkout with no dist');
  });

  it('leaves the suite, the dist smoke and the fresh install to CI, which runs them all', () => {
    const left = [...full.keys()].filter((name) => !checks.some((check) => check.name === name));
    assert.deepEqual(left, ['coverage gate', 'dist smoke', 'fresh install']);
    const ci = ciCommands();
    for (const script of ['tools/ci/coverage-cli.ts', 'tools/ci/dist-smoke-cli.ts', 'tools/ci/fresh-install-cli.ts']) {
      assert.ok(ci.some((command) => command.startsWith(`node ${script}`)), `CI no longer runs ${script}`);
    }
  });
});

describe('shortChecks (T3414)', () => {
  it('runs the scrub, the DCO sign-off, the size rule, the commit subjects and the typecheck of the full list, then the given specs, and no suite or build (T4080 C1)', () => {
    const full = new Map(localChecks('upstream/main').map((check) => [check.name, check]));
    const checks = shortChecks('upstream/main', ['src/a.test.ts', 'tools/b.test.ts']);
    assert.deepEqual(
      checks.map((check) => check.name),
      ['scrub: tree', 'scrub: commits', 'DCO', 'size rule', 'commit subjects', 'typecheck', 'changed specs'],
    );
    for (const check of checks.slice(0, 6)) assert.deepEqual(check, full.get(check.name), check.name);
    assert.deepEqual(checks.at(-1)?.argv, ['node', '--test', 'src/a.test.ts', 'tools/b.test.ts']);
  });

  it('leaves the specs out when no changed file has one', () => {
    assert.deepEqual(
      shortChecks(DEFAULT_BASE, []).map((check) => check.name),
      ['scrub: tree', 'scrub: commits', 'DCO', 'size rule', 'commit subjects', 'typecheck'],
    );
  });
});

describe('gateChanges (T4080 C2)', () => {
  it('names each changed file of the gate itself, the package and the TypeScript configs, in the order given', () => {
    const gate = ['.githooks/pre-push', '.github/workflows/ci.yml', 'tools/ci/local.ts', 'tools/ship/repos.json', 'src/push-guard/pass-record.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'];
    assert.deepEqual(gateChanges(['src/a.ts', ...gate, 'docs/a.md']), gate);
  });

  it('names none for source, specs, docs or a look-alike path', () => {
    assert.deepEqual(gateChanges(['src/a.ts', 'src/a.test.ts', 'docs/tools/ci/x.md', 'plugins/teamrig/package.json', 'src/push-guards/x.ts', 'tsconfig/x.json']), []);
  });
});

describe('changedSpecs (T3414)', () => {
  const tree = new Set(['src/a.test.ts', 'tools/ship/repos.test.ts', 'src/c.test.ts']);
  const exists = (path: string): boolean => tree.has(path);

  it("takes a changed spec and the spec beside any other changed file, each once, sorted", () => {
    assert.deepEqual(changedSpecs(['src/c.ts', 'src/a.ts', 'src/a.test.ts', 'tools/ship/repos.json'], exists), ['src/a.test.ts', 'src/c.test.ts', 'tools/ship/repos.test.ts']);
  });

  it('takes no spec for a file with none beside it, a deleted spec, or a name with no extension', () => {
    assert.deepEqual(changedSpecs(['src/b.ts', 'src/gone.test.ts', '.githooks/pre-push', 'docs/a.md', 'dir.v2/name'], exists), []);
  });
});
