import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, parseShipArgs, withPlanVersion, withRaisedVersion } from './ship-plan.ts';

test('reads a ship\'s repo, plan and base, merging only when asked', () => {
  assert.deepEqual(parseShipArgs(['C:/w', 'C:/s/plan.json']), { repo: 'C:/w', plan: 'C:/s/plan.json', base: 'origin/main', merge: false, noteFile: null });
  assert.deepEqual(parseShipArgs(['C:/w', 'C:/s/plan.json', 'origin/dev', '--merge']), { repo: 'C:/w', plan: 'C:/s/plan.json', base: 'origin/dev', merge: true, noteFile: null });
  assert.deepEqual(parseShipArgs(['C:/w', '--merge', '--note-file', 'C:/s/note.md', 'C:/s/plan.json']), { repo: 'C:/w', plan: 'C:/s/plan.json', base: 'origin/main', merge: true, noteFile: 'C:/s/note.md' });
});

test('refuses ship arguments it cannot read', () => {
  assert.throws(() => parseShipArgs(['C:/w']), /^Error: usage: ship\.ts <teamrig dir> <plan\.json>/);
  assert.throws(() => parseShipArgs(['C:/w', 'plan.json', 'origin/main', 'extra']), /usage: ship\.ts/);
  assert.throws(() => parseShipArgs(['C:/w', 'plan.json', '--push']), /usage: ship\.ts .* \(got --push\)/);
  assert.throws(() => parseShipArgs(['C:/w', 'plan.json', '--merge', '--note-file']), /--note-file needs a path/);
  assert.throws(() => parseShipArgs(['C:/w', 'plan.json', '--merge', '--note-file', '--merge']), /--note-file needs a path/);
  assert.throws(() => parseShipArgs(['C:/w', 'plan.json', '--note-file', 'n.md']), /pass --merge too/);
});

test('reads a plan\'s chunks and names what a malformed one lacks', () => {
  const plan = { chunks: [{ files: ['src/a.ts'], subject: 'a: why', body: 'because' }] };
  assert.deepEqual(parsePlan(JSON.stringify(plan), 'p.json'), plan.chunks);
  assert.throws(() => parsePlan('{"chunks": []}', 'p.json'), /p\.json: expected \{ "chunks": \[ \.\.\. \] \}/);
  assert.throws(() => parsePlan('[]', 'p.json'), /p\.json: expected/);
  assert.throws(() => parsePlan('{"chunks": [{"files": [], "subject": "s", "body": "b"}]}', 'p.json'), /p\.json: chunk 0 needs files \(non-empty\), subject and body/);
  assert.throws(() => parsePlan('{"chunks": [{"files": ["a"], "subject": "s"}]}', 'p.json'), /chunk 0 needs/);
});

test('moves the plan\'s subjects and bodies to the version the ship set, leaving longer versions alone', () => {
  const chunks = [
    { files: ['docs/a.md'], subject: 'docs: a', body: 'Needs 0.88.12.' },
    { files: ['plugins/teamrig/.claude-plugin/plugin.json'], subject: 'plugin: version 0.88.1, a fix', body: 'From 0.88.1 on (0.88.1).' },
  ];
  assert.deepEqual(withPlanVersion(chunks, { from: '0.88.1', to: '0.89.1' }), [
    { files: ['docs/a.md'], subject: 'docs: a', body: 'Needs 0.88.12.' },
    { files: ['plugins/teamrig/.claude-plugin/plugin.json'], subject: 'plugin: version 0.89.1, a fix', body: 'From 0.89.1 on (0.89.1).' },
  ]);
});

const VERSION_PATHS = ['plugins/teamrig/.claude-plugin/plugin.json', 'src/core/version.ts'];

test('sets the version the raise chunk\'s subject names to the one the files set, in every subject and body', () => {
  const chunks = [
    { files: ['docs/a.md'], subject: 'docs: a', body: 'Since 0.88.1, not 0.88.12.' },
    { files: ['src/core/version.ts', 'plugins/teamrig/.claude-plugin/plugin.json'], subject: 'plugin: version 0.88.1, a fix since 0.80.0', body: 'Raises to 0.88.1.' },
  ];
  assert.deepEqual(withRaisedVersion(chunks, VERSION_PATHS, '0.89.1'), [
    { files: ['docs/a.md'], subject: 'docs: a', body: 'Since 0.89.1, not 0.88.12.' },
    { files: ['src/core/version.ts', 'plugins/teamrig/.claude-plugin/plugin.json'], subject: 'plugin: version 0.89.1, a fix since 0.80.0', body: 'Raises to 0.89.1.' },
  ]);
});

test('keeps the plan when it names the version the files set, raises no version, or its raise subject names none', () => {
  const raise = { files: ['src/core/version.ts'], subject: 'plugin: version 0.89.1, a fix', body: '0.89.1' };
  assert.deepEqual(withRaisedVersion([raise], VERSION_PATHS, '0.89.1'), [raise]);
  const noRaise = { files: ['docs/a.md'], subject: 'docs: since 0.88.1', body: '0.88.1' };
  assert.deepEqual(withRaisedVersion([noRaise], VERSION_PATHS, '0.89.1'), [noRaise]);
  const unnamed = { files: ['src/core/version.ts'], subject: 'plugin: raise the version', body: 'from 0.88.1' };
  assert.deepEqual(withRaisedVersion([unnamed], VERSION_PATHS, '0.89.1'), [unnamed]);
});
