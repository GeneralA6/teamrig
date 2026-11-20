import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord } from '../core/guards.ts';
import { isServedMark, SENSITIVE_KEY, SERVED_MARK, servedMarkOf, statedMarkOf } from './served-mark.ts';
import { settingNodes } from './settings.ts';

describe('servedMarkOf', () => {
  it('reads the mark a key states, and takes any other value for no mark', () => {
    assert.equal(statedMarkOf({ [SERVED_MARK]: 'value' }), 'value');
    assert.equal(statedMarkOf({ [SERVED_MARK]: 'location' }), 'location');
    assert.equal(statedMarkOf({ type: 'string' }), undefined);
    for (const other of ['hidden', 'Value', '', true, 1, null, ['value']]) {
      assert.equal(isServedMark(other), false);
      assert.equal(statedMarkOf({ [SERVED_MARK]: other }), undefined);
    }
  });

  it('serves a key by its mark, and one with no mark with its value', () => {
    assert.equal(servedMarkOf('alerts.pageWebhookFile', { [SERVED_MARK]: 'location' }), 'location');
    assert.equal(servedMarkOf('alerts.pageWebhookEnv', { [SERVED_MARK]: 'value' }), 'value');
    assert.equal(servedMarkOf('messages.maxLines', { type: 'integer' }), 'value');
    assert.equal(servedMarkOf('messages.maxLines', { [SERVED_MARK]: 'location' }), 'location');
  });

  it('keeps a sensitive key with no mark, or with one that is no mark, as a location', () => {
    for (const path of ['alerts.pageWebhookFile', 'tools.apiKey', 'secretGuard.later', 'exec.Token', 'login.password', 'cloud.credentials', 'host.authFile']) {
      assert.equal(servedMarkOf(path, { type: 'string' }), 'location', path);
      assert.equal(servedMarkOf(path, { [SERVED_MARK]: 'shown' }), 'location', path);
    }
  });
});

describe('the served mark over the shipped schema', async () => {
  const schema: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8'));
  assert.ok(isRecord(schema));
  const nodes = [...settingNodes(schema)];
  const sensitive = nodes.filter(([path]) => SENSITIVE_KEY.test(path));

  it('is stated on every key whose path may name a secret or the place of one, so a new one cannot slip in', () => {
    assert.deepEqual(sensitive.filter(([, node]) => statedMarkOf(node) === undefined).map(([path]) => path), []);
    assert.ok(sensitive.length >= 16);
  });

  it('is one of the two marks wherever a key states it', () => {
    assert.deepEqual(nodes.filter(([, node]) => SERVED_MARK in node && statedMarkOf(node) === undefined).map(([path]) => path), []);
  });

  it('keeps as a location the three keys that say where a secret is kept, and no other', () => {
    assert.deepEqual(nodes.filter(([path, node]) => servedMarkOf(path, node) === 'location').map(([path]) => path), [
      'secretGuard.paths',
      'alerts.pageWebhookFile',
      'alerts.pageWebhookKey',
    ]);
  });
});
