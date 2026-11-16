import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseProfiles, profileFor, readProfiles, repoSlugs, slugOf } from './repos.ts';
import { DIST } from './ship-commits.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

const LOCAL = '"local":{"runner":"tools/ci/local.ts"}';

test('reads each repo\'s main branch, gate and check lists, looked up without regard to case', () => {
  const profiles = parseProfiles(`{"Owner/Repo":{"main":"main","gate":"ci","checks":["a","b"]}}`);
  assert.deepEqual(profileFor(profiles, 'owner/repo'), { slug: 'Owner/Repo', main: 'main', gate: 'ci', checks: ['a', 'b'], summary: null, local: { runner: null }, regenerated: [], flaky: [], aliases: [] });
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

test('reads the summary check, and refuses one that is blank or not among the checks', () => {
  const entry = (summary: string): string => `{"O/R":{"main":"main","gate":"ci","checks":["a","all"],"summary":${summary}}}`;
  assert.equal(profileFor(parseProfiles(entry('"all"')), 'O/R').summary, 'all');
  for (const summary of ['"b"', '""', '3', '["all"]']) {
    assert.throws(() => parseProfiles(entry(summary)), /O\/R "summary" needs the name of one of its "checks"/, summary);
  }
});

test('the shipped repos.json names each repo\'s every-check-passed job its summary', () => {
  const profiles = readProfiles();
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) assert.equal(profileFor(profiles, slug).summary, 'every check passed', slug);
});

test('the shipped repos.json calls regenerated exactly the dist and the version files a ship writes again', () => {
  const profiles = readProfiles();
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig').regenerated, [`${DIST}/`, ...TEAMRIG_VERSION_FILES.map(file => file.path)]);
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig-pane').regenerated, ['plugins/teamrig-pane/.claude-plugin/plugin.json']);
});

/** The status checks main's ruleset requires before GitHub accepts a merge. */
function rulesetRequiredChecks(): string[] {
  const ruleset: unknown = JSON.parse(readFileSync(new URL('../../.github/rulesets/main.json', import.meta.url), 'utf8'));
  assert.ok(typeof ruleset === 'object' && ruleset !== null && 'rules' in ruleset && Array.isArray(ruleset.rules));
  const contexts: string[] = [];
  for (const rule of ruleset.rules) {
    if (typeof rule !== 'object' || rule === null || !('parameters' in rule)) continue;
    const parameters: unknown = rule.parameters;
    if (typeof parameters !== 'object' || parameters === null || !('required_status_checks' in parameters) || !Array.isArray(parameters.required_status_checks)) continue;
    for (const check of parameters.required_status_checks) {
      if (typeof check === 'object' && check !== null && 'context' in check && typeof check.context === 'string') contexts.push(check.context);
    }
  }
  return contexts;
}

test('the shipped repos.json waits on GitHub for every check main\'s ruleset requires, so a merge is never refused while CI runs', () => {
  const required = rulesetRequiredChecks();
  assert.ok(required.length > 0, 'the ruleset requires a status check');
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(readProfiles(), slug);
    assert.equal(profile.gate, 'ci', slug);
    for (const check of required) assert.ok(profile.checks.includes(check), `${slug} waits for ${check}`);
  }
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
  const tests = teamrig.checks.filter(check => check.startsWith('test ('));
  assert.deepEqual(tests, ['ubuntu-latest', 'windows-latest', 'macos-latest'].map(os => `test (${os}, node 22)`));
  const matrix = (key: string): string[] => (new RegExp(`^ {8}${key}: \\[([^\\]]+)\\]$`, 'm').exec(workflow)?.[1] ?? '').split(',').map(item => item.trim());
  const run = matrix('os').flatMap(os => matrix('node').map(node => `test (${os}, node ${node})`));
  assert.deepEqual(tests, run, 'repos.json must wait for exactly the test runs ci.yml\'s matrix makes');
  assert.equal(teamrig.checks.length, jobs.length + tests.length);
});

test('both plugin repos wait for the plugin version gate, so a plugin change cannot merge without a version raise', () => {
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    const profile = profileFor(readProfiles(), slug);
    assert.ok(profile.checks.includes('plugin version gate'), slug);
  }
});

test('both repos keep their own local CI runner, which a ship runs before it pushes', () => {
  const profiles = readProfiles();
  for (const slug of ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']) {
    assert.deepEqual(profileFor(profiles, slug).local, { runner: 'tools/ci/local.ts' }, slug);
  }
});

test('reads the flaky checks, and refuses one not among the checks, the summary, a blank or a repeat (T2988)', () => {
  const entry = (flaky: string): string => `{"O/R":{"main":"main","gate":"ci","checks":["a","t","all"],"summary":"all","flaky":${flaky}}}`;
  assert.deepEqual(profileFor(parseProfiles(entry('["t"]')), 'O/R').flaky, ['t']);
  assert.deepEqual(profileFor(parseProfiles('{"O/R":{"main":"main","gate":"ci","checks":["a"]}}'), 'O/R').flaky, []);
  for (const flaky of ['["b"]', '["all"]', '[""]', '"t"']) {
    assert.throws(() => parseProfiles(entry(flaky)), /O\/R "flaky" needs a list of its "checks", the summary apart/, flaky);
  }
  assert.throws(() => parseProfiles(entry('["t","t"]')), /O\/R lists a flaky check twice/);
});

test('the shipped repos.json re-runs only teamrig\'s test legs once as flaky (T2532, T2988)', () => {
  const profiles = readProfiles();
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig').flaky, ['test (ubuntu-latest, node 22)', 'test (windows-latest, node 22)', 'test (macos-latest, node 22)']);
  assert.deepEqual(profileFor(profiles, 'GeneralA6/teamrig-pane').flaky, []);
});

test('finds a repo under each of its aliases, any case, as the same profile, and lists it once by its own name (T3275)', () => {
  const profiles = parseProfiles(`{"Old/Repo":{"aliases":["New/Repo"],"main":"main","gate":"ci","checks":["a"]},"Other/Repo":{"main":"main","gate":"ci","checks":["b"]}}`);
  assert.equal(profileFor(profiles, 'new/repo'), profileFor(profiles, 'Old/Repo'));
  assert.equal(profileFor(profiles, 'New/Repo').slug, 'Old/Repo');
  assert.deepEqual(profileFor(profiles, 'Old/Repo').aliases, ['New/Repo']);
  assert.deepEqual(repoSlugs(profiles), ['Old/Repo', 'Other/Repo']);
});

test('refuses an alias that is no <owner>/<repo> name, or a name that would find two repos', () => {
  assert.throws(() => parseProfiles('{"O/R":{"aliases":"N/R","main":"main","gate":"ci","checks":["a"]}}'), /O\/R "aliases" needs a list of <owner>\/<repo> names/);
  assert.throws(() => parseProfiles('{"O/R":{"aliases":["N"],"main":"main","gate":"ci","checks":["a"]}}'), /O\/R "aliases" needs a list/);
  assert.throws(() => parseProfiles('{"O/R":{"aliases":["N/R/x"],"main":"main","gate":"ci","checks":["a"]}}'), /O\/R "aliases" needs a list/);
  assert.throws(
    () => parseProfiles('{"O/R":{"main":"main","gate":"ci","checks":["a"]},"P/R":{"aliases":["o/r"],"main":"main","gate":"ci","checks":["a"]}}'),
    /repos\.json: o\/r names both O\/R and P\/R: a name finds one repo/,
  );
});

test('the shipped repos.json finds each repo under the organization it moves to as well', () => {
  const profiles = readProfiles();
  assert.equal(profileFor(profiles, 'teamrig/teamrig'), profileFor(profiles, 'GeneralA6/teamrig'));
  assert.equal(profileFor(profiles, 'teamrig/teamrig-pane'), profileFor(profiles, 'GeneralA6/teamrig-pane'));
  assert.deepEqual(repoSlugs(profiles), ['GeneralA6/teamrig', 'GeneralA6/teamrig-pane']);
});
