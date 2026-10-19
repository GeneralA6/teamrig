import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRecord } from '../lib/guards.ts';
import { DEFAULT_BASE, localChecks } from './local-checks.ts';

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
      else assert.fail(`CI runs \`${command}\`, which no local check covers: add it to local-checks.ts`);
    }
  });

  it("runs the plugin's own tests after the build, in an empty home", () => {
    const at = checks.findIndex((check) => check.name === 'plugin tests');
    assert.deepEqual(checks[at], { name: 'plugin tests', argv: ['claude', 'plugin', 'test', 'plugins/teamrig'], isolatedHome: true });
    assert.ok(at > checks.findIndex((check) => check.name === 'build: compile'), 'the mod loads the built dist');
  });

  it('checks the commits since the base, names each check once and reads no CI event', () => {
    assert.deepEqual(localChecks('upstream/main').find((check) => check.name === 'DCO')?.argv, ['node', 'tools/dco/cli.ts', '--range', 'upstream/main..HEAD']);
    assert.equal(new Set(checks.map((check) => check.name)).size, checks.length);
    assert.ok(argvs.every((argv) => !argv.includes('--github')));
  });
});
