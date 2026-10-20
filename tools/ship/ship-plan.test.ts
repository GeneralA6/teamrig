import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, parseShipArgs, withPlanVersion } from './ship-plan.ts';

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
