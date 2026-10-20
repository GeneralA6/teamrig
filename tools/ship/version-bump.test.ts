import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAMRIG_VERSION_FILES, bumpKindOf, bumped, compareVersions, formatVersion, parseVersion, versionIn, versionMention, withVersion } from './version-bump.ts';

const v = parseVersion;
const [pluginJson, kitVersion] = TEAMRIG_VERSION_FILES;

test('reads and writes a major.minor.patch version', () => {
  assert.deepEqual(v('0.88.1'), { major: 0, minor: 88, patch: 1 });
  assert.equal(formatVersion(v('10.0.12')), '10.0.12');
  assert.throws(() => v('0.88'), /0\.88: not a major\.minor\.patch version/);
  assert.throws(() => v('0.88.1-beta'), /not a major\.minor\.patch/);
});

test('orders versions part by part, as numbers', () => {
  assert.ok(compareVersions(v('0.9.0'), v('0.10.0')) < 0);
  assert.ok(compareVersions(v('1.0.0'), v('0.99.99')) > 0);
  assert.equal(compareVersions(v('0.88.1'), v('0.88.1')), 0);
});

test('names the part a change raised, or none when it did not raise the version', () => {
  assert.equal(bumpKindOf(v('0.88.0'), v('0.88.1')), 'patch');
  assert.equal(bumpKindOf(v('0.88.0'), v('0.89.0')), 'minor');
  assert.equal(bumpKindOf(v('0.88.3'), v('0.89.0')), 'minor');
  assert.equal(bumpKindOf(v('0.88.0'), v('1.0.0')), 'major');
  assert.equal(bumpKindOf(v('0.88.0'), v('0.88.0')), null);
  assert.equal(bumpKindOf(v('0.88.0'), v('0.87.5')), null);
});

test('raises a version by a kind, zeroing the parts below it', () => {
  assert.equal(formatVersion(bumped(v('0.89.0'), 'patch')), '0.89.1');
  assert.equal(formatVersion(bumped(v('0.89.2'), 'minor')), '0.90.0');
  assert.equal(formatVersion(bumped(v('0.89.2'), 'major')), '1.0.0');
});

test('reads and sets the version in teamrig\'s plugin.json and version.ts, leaving the rest as it was', () => {
  assert.ok(pluginJson !== undefined && kitVersion !== undefined);
  const json = '{\r\n  "name": "teamrig",\r\n  "version": "0.88.1",\r\n  "description": "v 0.88.1"\r\n}\r\n';
  assert.equal(formatVersion(versionIn(json, pluginJson)), '0.88.1');
  assert.equal(withVersion(json, pluginJson, v('0.89.1')), '{\r\n  "name": "teamrig",\r\n  "version": "0.89.1",\r\n  "description": "v 0.88.1"\r\n}\r\n');
  const ts = "/** The kit's version. */\nexport const KIT_VERSION = '0.88.1';\n";
  assert.equal(withVersion(ts, kitVersion, v('0.89.1')), "/** The kit's version. */\nexport const KIT_VERSION = '0.89.1';\n");
  assert.throws(() => versionIn('{}', pluginJson), /plugins\/teamrig\/\.claude-plugin\/plugin\.json: no version matching/);
  assert.throws(() => withVersion('export const OTHER = 1;', kitVersion, v('1.0.0')), /src\/core\/version\.ts: no version/);
});

test('finds a version written alone, never inside a longer one', () => {
  const mention = versionMention('0.88.1');
  assert.ok(mention.test('since 0.88.1, a tab'));
  assert.ok(mention.test('(0.88.1)'));
  assert.ok(mention.test('version 0.88.1.'));
  assert.ok(!mention.test('10.88.1'));
  assert.ok(!mention.test('0.88.12'));
  assert.ok(!mention.test(['0.88.1', '4'].join('.')));
  assert.ok(!mention.test('0x88x1'));
  assert.equal('0.88.1 and 0.88.1'.replace(versionMention('0.88.1', 'g'), '0.89.1'), '0.89.1 and 0.89.1');
});
