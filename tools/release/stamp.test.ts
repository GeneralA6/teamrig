import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { NEXT_RELEASE } from '../../src/config/migrate.ts';
import { holdsStamps, markersIn, stampText, strayStamps } from './stamp.ts';
import { MANIFEST } from './target.ts';

// Built from NEXT_RELEASE, so this spec holds no stamp a release would set.
const SINCE = `(since ${NEXT_RELEASE})`;
const FIRST = `firstRelease: '${NEXT_RELEASE}'`;
const FIRST_NAMED = ['firstRelease:', 'NEXT_RELEASE'].join(' ');

describe('release stamps (#1768)', () => {
  it('sets each docs since line and migration firstRelease still to set, and nothing else', () => {
    const text = [`- \`key\` ${SINCE} does a thing; since next week it does more.`, `  ${FIRST},`, `  ${FIRST_NAMED},`, `  ${FIRST_NAMED}_SOON,`, `  firstRelease: '0.243.0',`, '(since 0.375.0)'].join('\n');
    assert.equal(markersIn(text), 3);
    const stamped = ["- `key` (since 0.493.0) does a thing; since next week it does more.", "  firstRelease: '0.493.0',", "  firstRelease: '0.493.0',", `  ${FIRST_NAMED}_SOON,`, "  firstRelease: '0.243.0',", '(since 0.375.0)'];
    assert.equal(stampText(text, '0.493.0'), stamped.join('\n'));
  });

  it('refuses a version that is not MAJOR.MINOR.PATCH', () => {
    assert.throws(() => stampText(SINCE, 'v1'), /not a MAJOR\.MINOR\.PATCH version/);
  });

  it('stamps only the migrations, the docs, the guide and the config schema, and names a stamp anywhere else', () => {
    const stamped = ['src/config/migrate.ts', 'docs/configuration.md', 'docs/guides/keep-it-safe.md', 'plugins/teamrig/skills/teamrig-guide/commands.md', 'plugins/teamrig/config.schema.json', 'README.md'];
    const not = ['src/config/parse.ts', 'docs/diagram.svg', 'CHANGELOG.md', 'plugins/teamrig/dist/config/migrate.js'];
    assert.deepEqual([stamped.map(holdsStamps), not.map(holdsStamps)], [stamped.map(() => true), not.map(() => false)]);
    const files = new Map([
      ['docs/a.md', SINCE],
      ['src/config/parse.ts', `${FIRST} ${SINCE}`],
      ['src/core/home.ts', 'no stamp'],
    ]);
    assert.deepEqual(strayStamps(files), [{ path: 'src/config/parse.ts', count: 2 }]);
  });
});

describe('stamp-cli.ts (#1768)', () => {
  const CLI = fileURLToPath(new URL('./stamp-cli.ts', import.meta.url));
  let repo: TempRepo;
  const read = (path: string): string => readFileSync(join(repo.dir, path), 'utf8');

  beforeEach(() => {
    repo = new TempRepo('release-stamp').init();
    repo.write(MANIFEST, JSON.stringify({ name: 'teamrig', version: '0.493.0' }));
    repo.write('docs/a.md', `A key ${SINCE}.\n`);
    repo.write('src/config/migrate.ts', `export const M = { from: 8, ${FIRST} };\n`);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'one');
  });

  afterEach(() => repo.remove());

  it("sets each stamp to the version the checkout's plugin.json holds, and says how many in which files", () => {
    const run = repo.run(CLI, ['--root', repo.dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '  docs/a.md: 1\n  src/config/migrate.ts: 1\nstamps: set 2 to 0.493.0\n');
    assert.deepEqual([read('docs/a.md'), read('src/config/migrate.ts')], ['A key (since 0.493.0).\n', "export const M = { from: 8, firstRelease: '0.493.0' };\n"]);
    assert.equal(repo.run(CLI, ['--root', repo.dir]).stdout, 'stamps: set 0 to 0.493.0\n', 'a second run finds none');
  });

  it('checks without writing, failing on a stamp in a file no release stamps', () => {
    assert.deepEqual([repo.run(CLI, ['--root', repo.dir, '--check']).status, read('docs/a.md')], [0, `A key ${SINCE}.\n`]);
    repo.write('src/config/parse.ts', `// ${SINCE}\n`);
    repo.git('add', '-A');
    const run = repo.run(CLI, ['--root', repo.dir, '--check']);
    assert.deepEqual([run.status, run.stdout.split('\n').at(-2)], [1, '  src/config/parse.ts: 1']);
    assert.equal(repo.run(CLI, ['--root', repo.dir, '--bogus']).status, 2);
  });

  it('sets nothing and says why when plugin.json holds no release version', () => {
    repo.write(MANIFEST, JSON.stringify({ name: 'teamrig' }));
    const run = repo.run(CLI, ['--root', repo.dir]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /holds no MAJOR\.MINOR\.PATCH version/);
    assert.equal(read('docs/a.md'), `A key ${SINCE}.\n`);
  });
});
