import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settingAt, settingValueOf, withSetting, type SettingShape } from './setting-edit.ts';

const MAX_LINES: SettingShape = { path: 'messages.maxLines', type: 'integer', min: 3, max: 50 };
const MODE: SettingShape = { path: 'messages.mode', type: 'string', enum: ['hold', 'send'] };
const TAGS: SettingShape = { path: 'messages.tags', type: 'array', items: 'string' };
const SIZES: SettingShape = { path: 'focus.sizes', type: 'array', items: 'integer' };

describe('settingValueOf', () => {
  it('reads each type a key takes from its text', () => {
    assert.deepEqual(settingValueOf(MAX_LINES, '12'), { ok: true, value: 12 });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'number' }, '99.5'), { ok: true, value: 99.5 });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'boolean' }, 'false'), { ok: true, value: false });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'string' }, ' as typed '), { ok: true, value: ' as typed ' });
    assert.deepEqual(settingValueOf(MODE, 'send'), { ok: true, value: 'send' });
  });

  it('reads a list as JSON or as a comma list, each item by the list type', () => {
    assert.deepEqual(settingValueOf(TAGS, 'a, b'), { ok: true, value: ['a', 'b'] });
    assert.deepEqual(settingValueOf(TAGS, '["a,b","c"]'), { ok: true, value: ['a,b', 'c'] });
    assert.deepEqual(settingValueOf(TAGS, ''), { ok: true, value: [] });
    assert.deepEqual(settingValueOf(SIZES, '[2, 3]'), { ok: true, value: [2, 3] });
    assert.deepEqual(settingValueOf(SIZES, '2,3'), { ok: true, value: [2, 3] });
  });

  it('refuses a value of another type, off its choices or out of its bounds, naming the key', () => {
    assert.deepEqual(settingValueOf(MAX_LINES, 'many'), { ok: false, problem: 'messages.maxLines takes an integer, not "many"' });
    assert.deepEqual(settingValueOf(MAX_LINES, '1.5'), { ok: false, problem: 'messages.maxLines takes an integer, not "1.5"' });
    assert.deepEqual(settingValueOf(MAX_LINES, '51'), { ok: false, problem: 'messages.maxLines takes 3 to 50, not 51' });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'number', min: 0 }, '-1'), { ok: false, problem: 'p takes 0 or more, not -1' });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'number', max: 9 }, '10'), { ok: false, problem: 'p takes 9 or less, not 10' });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'number' }, ''), { ok: false, problem: 'p takes a number, not ""' });
    assert.deepEqual(settingValueOf({ path: 'p', type: 'boolean' }, 'yes'), { ok: false, problem: 'p takes a boolean, not "yes"' });
    assert.deepEqual(settingValueOf(MODE, 'drop'), { ok: false, problem: 'messages.mode takes one of "hold", "send", not "drop"' });
    assert.deepEqual(settingValueOf(SIZES, '[2, "x"]'), { ok: false, problem: 'focus.sizes takes an integer, not "x"' });
    assert.deepEqual(settingValueOf(SIZES, '[1'), { ok: false, problem: 'focus.sizes takes a list: [1 is not a JSON array' });  });
});

describe('withSetting', () => {
  const FILE = { team: 'x', messages: { maxLines: 12, mode: 'hold' } };

  it('sets a nested key, making its object when the file has none, and keeps every other key', () => {
    assert.deepEqual(withSetting(FILE, 'messages.maxLines', 20), { team: 'x', messages: { maxLines: 20, mode: 'hold' } });
    assert.deepEqual(withSetting(FILE, 'focus.wip', 2), { ...FILE, focus: { wip: 2 } });
    assert.deepEqual(withSetting(FILE, 'timeZone', 'UTC'), { ...FILE, timeZone: 'UTC' });
  });

  it('removes a key to read its default, and the object it leaves empty', () => {
    assert.deepEqual(withSetting(FILE, 'messages.maxLines', undefined), { team: 'x', messages: { mode: 'hold' } });
    assert.deepEqual(withSetting({ team: 'x', messages: { maxLines: 12 } }, 'messages.maxLines', undefined), { team: 'x' });
    assert.deepEqual(withSetting(FILE, 'focus.wip', undefined), FILE);
  });

  it('reads the value a dotted path holds', () => {
    assert.equal(settingAt(FILE, 'messages.maxLines'), 12);
    assert.equal(settingAt(FILE, 'messages.maxLines.deeper'), undefined);
    assert.equal(settingAt(FILE, 'focus.wip'), undefined);
  });
});
