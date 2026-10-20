import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProfiles, profileFor, readProfiles, slugOf } from './repos.ts';

const LOCAL = '"local":{"runner":"tools/ci/local.ts","fallback":[{"name":"lint","run":["node","lint.ts"]},{"name":"sync","run":["node","sync.ts","--check"],"cwd":"plugins/x"}]}';

test('reads each repo\'s main branch, gate and check lists, looked up without regard to case', () => {
  const profiles = parseProfiles(`{"Owner/Repo":{"main":"main","gate":"ci","checks":["a","b"]}}`);
  assert.deepEqual(profileFor(profiles, 'owner/repo'), { slug: 'Owner/Repo', main: 'main', gate: 'ci', checks: ['a', 'b'], local: { runner: null, fallback: [] } });
  const local = parseProfiles(`{"Owner/Local":{"main":"main","gate":"local","checks":[],${LOCAL}}}`);
  assert.deepEqual(profileFor(local, 'Owner/Local').local, {
    runner: 'tools/ci/local.ts',
    fallback: [
      { name: 'lint', run: ['node', 'lint.ts'], cwd: null },
      { name: 'sync', run: ['node', 'sync.ts', '--check'], cwd: 'plugins/x' },
    ],
  });
});

test('a repo with no entry, or a gate with nothing to check, cannot merge', () => {
  const profiles = parseProfiles(`{"Owner/Empty":{"main":"main","gate":"ci","checks":[],${LOCAL}},"Owner/NoLocal":{"main":"main","gate":"local","checks":["a"]}}`);
  assert.throws(() => profileFor(profiles, 'Owner/Other'), /no check list for Owner\/Other: add it to repos\.json/);
  assert.throws(() => profileFor(profiles, 'Owner/Empty'), /lists no checks in repos\.json/);
  assert.throws(() => profileFor(profiles, 'Owner/NoLocal'), /lists no local checks in repos\.json/);
});

test('refuses an entry with no main, a blank or non-text check, or a check listed twice', () => {
  assert.throws(() => parseProfiles('[]'), /expected \{ "<owner>\/<repo>"/);
  assert.throws(() => parseProfiles('{"O/R":{"gate":"ci","checks":["a"]}}'), /O\/R needs "main"/);
  assert.throws(() => parseProfiles('{"O/R":{"main":"main","gate":"ci","checks":["a",""]}}'), /O\/R needs "main" and a "checks" list/);
  assert.throws(() => parseProfiles('{"O/R":{"main":"main","gate":"ci","checks":["a",3]}}'), /O\/R needs "main" and a "checks" list/);
  assert.throws(() => parseProfiles('{"O/R":{"main":"main","gate":"ci","checks":["a","a"]}}'), /O\/R lists a check twice/);
});

test('refuses a missing or unknown gate', () => {
  assert.throws(() => parseProfiles('{"O/R":{"main":"main","checks":["a"]}}'), /O\/R needs a "gate": "ci" \(GitHub checks\) or "local"/);
  assert.throws(() => parseProfiles('{"O/R":{"main":"main","gate":"both","checks":["a"]}}'), /O\/R needs a "gate"/);
});

test('refuses local checks without a fallback list, a name or a command, with a blank folder or runner, or named twice', () => {
  const entry = (local: string): string => `{"O/R":{"main":"main","gate":"local","checks":[],"local":${local}}}`;
  assert.throws(() => parseProfiles(entry('[]')), /O\/R "local" needs a "fallback" list/);
  assert.throws(() => parseProfiles(entry('{"runner":"x.ts"}')), /O\/R "local" needs a "fallback" list/);
  assert.throws(() => parseProfiles(entry('{"runner":"","fallback":[]}')), /O\/R has a local "runner" that is not a path/);
  assert.throws(() => parseProfiles(entry('{"fallback":["lint"]}')), /O\/R local check 0 needs a "name"/);
  assert.throws(() => parseProfiles(entry('{"fallback":[{"name":" ","run":["a"]}]}')), /local check 0 needs a "name"/);
  assert.throws(() => parseProfiles(entry('{"fallback":[{"name":"lint","run":[]}]}')), /local check 0 \(lint\) needs a "run" list/);
  assert.throws(() => parseProfiles(entry('{"fallback":[{"name":"lint","run":"node lint.ts"}]}')), /\(lint\) needs a "run" list/);
  assert.throws(() => parseProfiles(entry('{"fallback":[{"name":"lint","run":["a"],"cwd":""}]}')), /\(lint\) has a "cwd" that is not a folder/);
  assert.throws(() => parseProfiles(entry('{"fallback":[{"name":"lint","run":["a"]},{"name":"lint","run":["b"]}]}')), /O\/R names a local check twice/);
});

test('finds the GitHub slug in an SSH or HTTPS remote', () => {
  assert.equal(slugOf('git@github.com:GeneralA6/teamrig.git'), 'GeneralA6/teamrig');
  assert.equal(slugOf('https://github.com/GeneralA6/teamrig-pane'), 'GeneralA6/teamrig-pane');
  assert.equal(slugOf('https://github.com/Owner/repo.js.git/\n'), 'Owner/repo.js');
  assert.throws(() => slugOf('git@example.com:Owner/repo.git'), /is not a GitHub remote/);
});

test('the shipped repos.json still lists every job a teamrig pull request runs, for when its CI is back', () => {
  const teamrig = profileFor(readProfiles(), 'GeneralA6/teamrig');
  assert.equal(teamrig.main, 'main');
  assert.equal(teamrig.checks.length, 9);
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    for (const node of [22, 24]) assert.ok(teamrig.checks.includes(`test (${os}, node ${node})`));
  }
});

test('both plugin repos wait for the plugin version gate, so a plugin change cannot merge without a version raise', () => {
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(readProfiles(), slug);
    assert.ok(profile.checks.includes('plugin version gate'), slug);
    assert.ok(profile.local.fallback.some(check => check.name === 'plugin version gate'), slug);
  }
});

test('while CI is paused both repos merge on the local gate, whose fallback runs every check their CI runs here', () => {
  const profiles = readProfiles();
  const names = (slug: string): string[] => profileFor(profiles, slug).local.fallback.map(check => check.name);
  const common = ['plugin version gate', 'scrub: tree', 'scrub: commits', 'DCO', 'size rule', 'typecheck', 'coverage gate'];
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(profiles, slug);
    assert.equal(profile.gate, 'local', slug);
    assert.equal(profile.local.runner, 'tools/ci/local.ts', slug);
    for (const name of common) assert.ok(names(slug).includes(name), `${slug}: ${name}`);
  }
  for (const name of ['build: clean', 'build: compile', 'dist matches the source', 'dist smoke', 'doc pictures', 'doc links']) assert.ok(names('GeneralA6/teamrig').includes(name), name);
  for (const name of ['plugin tests: none skipped', 'doc pictures', 'typecheck: pane', 'hooks/core matches the teamrig pin', 'plugin tests']) assert.ok(names('GeneralA6/teamrig-pane').includes(name), name);
});
