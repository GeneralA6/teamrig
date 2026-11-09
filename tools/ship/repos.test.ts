import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseProfiles, profileFor, readProfiles, slugOf } from './repos.ts';
import { DIST } from './ship-commits.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

const LOCAL = '"local":{"runner":"tools/ci/local.ts"}';

test('reads each repo\'s main branch, gate and check lists, looked up without regard to case', () => {
  const profiles = parseProfiles(`{"Owner/Repo":{"main":"main","gate":"ci","checks":["a","b"]}}`);
  assert.deepEqual(profileFor(profiles, 'owner/repo'), { slug: 'Owner/Repo', main: 'main', gate: 'ci', checks: ['a', 'b'], local: { runner: null }, regenerated: [] });
  const local = parseProfiles(`{"Owner/Local":{"main":"main","gate":"local","checks":[],${LOCAL}}}`);
  assert.deepEqual(profileFor(local, 'Owner/Local').local, { runner: 'tools/ci/local.ts' });
});

test('a repo with no entry, or a gate with nothing to check, cannot merge', () => {
  const profiles = parseProfiles(`{"Owner/Empty":{"main":"main","gate":"ci","checks":[],${LOCAL}},"Owner/NoLocal":{"main":"main","gate":"local","checks":["a"]}}`);
  assert.throws(() => profileFor(profiles, 'Owner/Other'), /no check list for Owner\/Other: add it to repos\.json/);
  assert.throws(() => profileFor(profiles, 'Owner/Empty'), /lists no checks in repos\.json/);
  assert.throws(() => profileFor(profiles, 'Owner/NoLocal'), /names no local runner in repos\.json/);
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

test('refuses a "local" entry that names no runner path', () => {
  const entry = (local: string): string => `{"O/R":{"main":"main","gate":"local","checks":[],"local":${local}}}`;
  for (const local of ['[]', '{}', '{"runner":""}', '{"runner":" "}', '{"runner":3}']) {
    assert.throws(() => parseProfiles(entry(local)), /O\/R "local" needs a "runner": the path of the repo's local CI runner/, local);
  }
});

test('reads the regenerated paths a reship writes again, and refuses a path outside the repo or listed twice', () => {
  const entry = (regenerated: string): string => `{"O/R":{"main":"main","gate":"ci","checks":["a"],"regenerated":${regenerated}}}`;
  assert.deepEqual(profileFor(parseProfiles(entry('["dist/","plugin.json"]')), 'O/R').regenerated, ['dist/', 'plugin.json']);
  for (const regenerated of ['"dist/"', '[3]', '[""]', '["/dist/"]', '["a/../b"]']) {
    assert.throws(() => parseProfiles(entry(regenerated)), /O\/R "regenerated" needs a list of paths inside the repo \(a folder ends in \/\)/, regenerated);
  }
  assert.throws(() => parseProfiles(entry('["dist/","dist/"]')), /O\/R lists a regenerated path twice/);
});

test('the shipped repos.json calls regenerated exactly the dist and the version files a ship writes again', () => {
  const profiles = readProfiles();
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig').regenerated, [`${DIST}/`, ...TEAMRIG_VERSION_FILES.map(file => file.path)]);
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig-pane').regenerated, ['plugins/teamrig-pane/.claude-plugin/plugin.json']);
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
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = [...workflow.matchAll(/^ {4}name: (.+)$/gm)].map(match => match[1] ?? '').filter(name => !name.includes('${{'));
  assert.ok(jobs.includes('commit size rule'), jobs.join(', '));
  for (const job of jobs) assert.ok(teamrig.checks.includes(job), `ci.yml job "${job}" is missing from repos.json, so a CI merge would not wait for it`);
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    for (const node of [22, 24]) assert.ok(teamrig.checks.includes(`test (${os}, node ${node})`));
  }
  assert.equal(teamrig.checks.length, jobs.length + 6);
});

test('both plugin repos wait for the plugin version gate, so a plugin change cannot merge without a version raise', () => {
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(readProfiles(), slug);
    assert.ok(profile.checks.includes('plugin version gate'), slug);
  }
});

test('while CI is paused both repos merge on the local gate, proved by their own local CI runner', () => {
  const profiles = readProfiles();
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(profiles, slug);
    assert.equal(profile.gate, 'local', slug);
    assert.deepEqual(profile.local, { runner: 'tools/ci/local.ts' }, slug);
  }
});
