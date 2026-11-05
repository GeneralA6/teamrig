import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { FakeGit } from '../lib/fake-git.ts';
import { checkPluginVersions, MARKETPLACE, readCatalog } from './plugin-version.ts';

const MANIFEST = 'plugins/demo/.claude-plugin/plugin.json';
const ENDS = { base: 'base', head: 'head' } as const;

function catalogText(entry: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ name: 'demo', plugins: [{ name: 'demo', source: './plugins/demo', ...entry }] });
}

function manifestText(version: string | undefined): string {
  return JSON.stringify(version === undefined ? { name: 'demo' } : { name: 'demo', version });
}

interface Change {
  readonly changed: readonly string[];
  /** plugin.json at the head and at the base; `undefined` when that end has none. */
  readonly head: string | undefined;
  readonly base: string | undefined;
  readonly catalog?: string | undefined;
  readonly manifest?: string;
}

/** A git that answers the check's calls for one change from `base` to `head`. */
function gitFor(change: Change): FakeGit {
  const manifest = change.manifest ?? MANIFEST;
  const responses: Record<string, string> = {
    'merge-base base head': 'fork\n',
    'diff --no-renames --name-only -z fork head': change.changed.map((path) => `${path}\0`).join(''),
    [`ls-tree --name-only head -- ${MARKETPLACE}`]: change.catalog === undefined ? '' : `${MARKETPLACE}\n`,
  };
  if (change.catalog !== undefined) {
    responses[`show head:${MARKETPLACE}`] = change.catalog;
  }
  for (const [end, text] of [['head', change.head], ['base', change.base]] as const) {
    responses[`ls-tree --name-only ${end} -- ${manifest}`] = text === undefined ? '' : `${manifest}\n`;
    if (text !== undefined) {
      responses[`show ${end}:${manifest}`] = text;
    }
  }
  return new FakeGit(responses);
}

async function run(change: Change): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
  const lines: string[] = [];
  const code = await checkPluginVersions(ENDS, { git: gitFor({ catalog: catalogText(), ...change }), out: (line) => lines.push(line) });
  return { code, lines };
}

describe('readCatalog', () => {
  it('lists the plugins whose source is a folder in the repo', () => {
    const text = JSON.stringify({
      plugins: [
        { name: 'local', source: './plugins/local/' },
        { name: 'remote', source: { source: 'github', repo: 'someone/else' } },
        { name: 'root', source: './' },
        'not an entry',
      ],
    });
    assert.deepEqual(readCatalog(text), {
      plugins: [
        { name: 'local', folder: 'plugins/local' },
        { name: 'root', folder: '' },
      ],
      problems: [],
    });
  });

  it('flags an entry that gives a version, which Claude Code ignores', () => {
    const { problems } = readCatalog(JSON.stringify({ plugins: [{ name: 'demo', source: './p', version: '0.1.0' }, { version: '1.0.0' }] }));
    assert.deepEqual(problems, [
      `demo: drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`,
      `(unnamed): drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`,
    ]);
  });

  it('refuses a catalog without a plugins list', () => {
    assert.throws(() => readCatalog('{"name":"demo"}'), /has no "plugins" list/);
    assert.throws(() => readCatalog('[]'), /has no "plugins" list/);
  });
});

describe('checkPluginVersions', () => {
  it('passes a change under the plugin folder that raises the version', async () => {
    const result = await run({ changed: [MANIFEST, 'plugins/demo/hooks/a.ts'], head: manifestText('0.2.0'), base: manifestText('0.1.0') });
    assert.deepEqual(result, { code: EXIT_CLEAN, lines: ['plugin-version: demo 0.1.0 -> 0.2.0: 2 file(s) under plugins/demo/ changed'] });
  });

  it('fails a change under the plugin folder that keeps the version', async () => {
    const result = await run({ changed: ['plugins/demo/hooks/a.ts'], head: manifestText('0.1.0'), base: manifestText('0.1.0') });
    assert.deepEqual(result, {
      code: EXIT_FINDINGS,
      lines: [
        `plugin-version: demo: 1 file(s) under plugins/demo/ changed, but ${MANIFEST} still gives 0.1.0 (the base: 0.1.0); ` +
          'raise it, or installed copies never receive the change',
      ],
    });
  });

  it('fails a change that lowers the version', async () => {
    const result = await run({ changed: [MANIFEST], head: manifestText('0.1.9'), base: manifestText('0.2.0') });
    assert.equal(result.code, EXIT_FINDINGS);
    assert.match(result.lines.join('\n'), /still gives 0\.1\.9 \(the base: 0\.2\.0\)/);
  });

  it('passes a change outside the plugin folder, a sibling folder with the same prefix included', async () => {
    const result = await run({ changed: ['README.md', 'plugins/demo-other/a.ts', 'tools/ci/x.ts'], head: manifestText('0.1.0'), base: manifestText('0.1.0') });
    assert.deepEqual(result, { code: EXIT_CLEAN, lines: ['plugin-version: demo 0.1.0: nothing under plugins/demo/ changed'] });
  });

  it('fails a marketplace entry that gives a version, even when the plugin did not change', async () => {
    const result = await run({ changed: [], head: manifestText('0.1.0'), base: manifestText('0.1.0'), catalog: catalogText({ version: '0.1.0' }) });
    assert.equal(result.code, EXIT_FINDINGS);
    assert.deepEqual(result.lines, [
      `plugin-version: demo: drop "version" from its ${MARKETPLACE} entry; Claude Code installs the version in plugin.json and ignores this one`,
      'plugin-version: demo 0.1.0: nothing under plugins/demo/ changed',
    ]);
  });

  it('fails a plugin.json that is missing, gives no version or gives one that is not MAJOR.MINOR.PATCH', async () => {
    const missing = await run({ changed: [], head: undefined, base: manifestText('0.1.0') });
    assert.deepEqual(missing, { code: EXIT_FINDINGS, lines: [`plugin-version: demo: ${MANIFEST} is missing`] });
    const none = await run({ changed: [], head: manifestText(undefined), base: undefined });
    assert.deepEqual(none.lines, [`plugin-version: demo: ${MANIFEST} needs a "version" of the form MAJOR.MINOR.PATCH, found null`]);
    const loose = await run({ changed: [], head: manifestText('1.0'), base: undefined });
    assert.deepEqual(loose.lines, [`plugin-version: demo: ${MANIFEST} needs a "version" of the form MAJOR.MINOR.PATCH, found "1.0"`]);
    const notObject = await run({ changed: [], head: '"0.1.0"', base: undefined });
    assert.equal(notObject.code, EXIT_FINDINGS);
  });

  it('passes a new plugin, or one whose base gives no usable version', async () => {
    for (const base of [undefined, manifestText(undefined), manifestText('next')]) {
      const result = await run({ changed: [MANIFEST], head: manifestText('0.1.0'), base });
      assert.deepEqual(result, { code: EXIT_CLEAN, lines: ['plugin-version: demo 0.1.0: the base gives no version to raise'] });
    }
  });

  it('counts every change in the repo for a plugin at the repo root', async () => {
    const root = '.claude-plugin/plugin.json';
    const catalog = JSON.stringify({ plugins: [{ name: 'demo', source: './' }] });
    const kept = await run({ changed: ['README.md'], head: manifestText('1.0.0'), base: manifestText('1.0.0'), catalog, manifest: root });
    assert.equal(kept.code, EXIT_FINDINGS);
    assert.match(kept.lines.join('\n'), /1 file\(s\) under the repo changed, but \.claude-plugin\/plugin\.json still gives 1\.0\.0/);
    const raised = await run({ changed: ['README.md'], head: manifestText('1.0.1'), base: manifestText('1.0.0'), catalog, manifest: root });
    assert.deepEqual(raised.lines, ['plugin-version: demo 1.0.0 -> 1.0.1: 1 file(s) under the repo changed']);
  });

  it('refuses a head without a marketplace, or one that names no plugin in the repo', async () => {
    await assert.rejects(run({ changed: [], head: undefined, base: undefined, catalog: undefined }), new RegExp(`${MARKETPLACE} is missing at head`));
    const remoteOnly = JSON.stringify({ plugins: [{ name: 'demo', source: { source: 'github', repo: 'someone/else' } }] });
    await assert.rejects(run({ changed: [], head: undefined, base: undefined, catalog: remoteOnly }), /names no plugin from a folder in this repo/);
  });
});
