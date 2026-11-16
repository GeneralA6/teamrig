import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRecord, recordField, stringField, type JsonRecord } from '../lib/guards.ts';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/release.yml');

/** Each job's text, from its `  <id>:` line to the next job's. */
const jobs: ReadonlyMap<string, string> = new Map(
  (workflow.split(/^jobs:\n/m)[1] ?? '')
    .split(/^(?= {2}[\w-]+:$)/m)
    .map((block) => [/^ {2}([\w-]+):$/m.exec(block)?.[1] ?? '', block]),
);
const job = (id: string): string => {
  const text = jobs.get(id);
  assert.ok(text !== undefined, `release.yml has the job ${id}`);
  return text;
};

/** A job's own permissions block, as `name: level` lines; empty when it keeps the workflow's read-only token. */
const permissionsOf = (text: string): readonly string[] => [...(/^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(text)?.[1] ?? '').matchAll(/^ {6}(.+)$/gm)].map((match) => match[1] ?? '');

function readRecord(path: string): JsonRecord {
  const parsed: unknown = JSON.parse(read(path));
  assert.ok(isRecord(parsed), `${path} is a JSON object`);
  return parsed;
}

describe('release.yml', () => {
  it('runs by hand only, until pull requests stop raising the version themselves', () => {
    assert.match(workflow, /^on:\n(?: {2}#.*\n)*? {2}workflow_dispatch:\n\n/m);
  });

  it('runs one release at a time and never cancels one half-way', () => {
    assert.match(workflow, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false\n/m);
  });

  it('has the release pull request, build and publish jobs, each stopping within 20 minutes', () => {
    assert.deepEqual([...jobs.keys()], ['release-please', 'build', 'publish']);
    for (const [id, text] of jobs) assert.match(text, /^ {4}timeout-minutes: 20$/m, id);
  });

  it('keeps the release pull request on main, with only the writes it needs', () => {
    const text = job('release-please');
    assert.match(text, /^ {4}if: \$\{\{ !github\.event\.repository\.private && github\.ref == 'refs\/heads\/main' \}\}$/m);
    assert.deepEqual(permissionsOf(text), ['actions: write', 'contents: write', 'pull-requests: write']);
    assert.match(text, /^ {10}config-file: release-please-config\.json\n {10}manifest-file: \.release-please-manifest\.json$/m);
  });

  it('runs ci.yml on the release pull request, which the job token cannot start by opening it', () => {
    assert.match(job('release-please'), /run: gh workflow run ci\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$BRANCH"\n/);
  });

  it('builds with the read-only token, and no package script runs at install', () => {
    const text = job('build');
    assert.deepEqual(permissionsOf(text), []);
    assert.match(text, /^ {4}if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}$/m);
    assert.match(text, /^ {6}- run: npm ci --ignore-scripts$/m);
    assert.match(text, /^ {6}- run: npm run build$/m);
    assert.match(text, /^ {10}persist-credentials: false$/m);
  });

  it('publishes with a contents write only, running no npm package, from the commit release-please tagged', () => {
    const text = job('publish');
    assert.deepEqual(permissionsOf(text), ['contents: write']);
    assert.match(text, /^ {4}needs: \[release-please, build\]$/m);
    assert.doesNotMatch(text, /^ {6}- run: .*\bnp[mx]\b/m);
    assert.match(text, /^ {10}ref: \$\{\{ needs\.release-please\.outputs\.sha \}\}$/m);
    assert.match(text, /^ {6}- run: node tools\/release\/publish-cli\.ts --version "\$VERSION" --source "\$SOURCE"$/m);
  });

  it('keeps the push token only in the publish job: every other checkout drops it', () => {
    for (const [id, text] of jobs) {
      if (id === 'publish') continue;
      const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
      const dropped = text.match(/^ {10}persist-credentials: false$/gm)?.length ?? 0;
      assert.equal(dropped, checkouts, id);
    }
  });
});

describe('release-please-config.json', () => {
  const config = readRecord('release-please-config.json');
  const root = recordField(recordField(config, 'packages') ?? {}, '.') ?? {};

  it('raises the plugin version in plugin.json and src/core/version.ts, the files a test holds equal', () => {
    assert.deepEqual(root['extra-files'], [
      { type: 'json', path: 'plugins/teamrig/.claude-plugin/plugin.json', jsonpath: '$.version' },
      { type: 'generic', path: 'src/core/version.ts' },
    ]);
    assert.match(read('src/core/version.ts'), /^export const KIT_VERSION = '\d+\.\d+\.\d+';$/m);
  });

  it('marks the version in a release-please block of its own lines, so a work commit never edits the version line', () => {
    // A block with no end marker runs to the end of the file in release-please 17.6.0's generic updater.
    const version = read('src/core/version.ts');
    assert.match(version, /^\/\/ x-release-please-start-version\b.*\n(?:(?!export const)[^\n]*\n)*export const KIT_VERSION = /);
    assert.doesNotMatch(version, /x-release-please-end|x-release-please-version/);
  });

  it('tags main teamrig-v<version>, leaving v<version> to the published build an install can pin', () => {
    assert.equal(stringField(root, 'component'), 'teamrig');
    assert.equal(root['include-component-in-tag'], true);
  });

  it('signs off its commits as the Actions bot, which the DCO gate reads as their author', () => {
    assert.equal(stringField(config, 'signoff'), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
  });

  it('starts from a commit of main, not from the whole history', () => {
    assert.match(stringField(config, 'bootstrap-sha') ?? '', /^[0-9a-f]{40}$/);
  });

  it('holds the version the next release raises from in its manifest', () => {
    assert.match(stringField(readRecord('.release-please-manifest.json'), '.') ?? '', /^\d+\.\d+\.\d+$/);
  });
});
