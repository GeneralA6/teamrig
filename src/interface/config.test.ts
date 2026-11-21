import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { configBody, cutText, KEPT_NOTE, SETTING_PROBLEM, type ConfigBody, type ConfigInput, type SettingInput } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');
const SHAPE = new SecretScanner().find(SECRET)?.description ?? '';
const CUT = cutText(SHAPE);

const FIELDS = ['path', 'group', 'type', 'items', 'enum', 'min', 'max', 'value', 'default', 'isDefault', 'meaning', 'editable', 'gatedBy', 'readOnly', 'problem', 'kept'];

function row(overrides: Partial<SettingInput> = {}): SettingInput {
  return {
    path: 'messages.maxLines',
    group: 'messages',
    type: 'integer',
    value: 12,
    default: 10,
    isDefault: false,
    meaning: 'How long a message may be.',
    editable: true,
    served: 'value',
    ...overrides,
  };
}

function bodyOf(settings: readonly SettingInput[], overrides: Partial<ConfigInput> = {}): ConfigBody {
  return configBody({ team: 'app', teams: [], timeZone: 'UTC', priorities: [], settings, shapes: new SecretScanner(), ...overrides });
}

function only(body: ConfigBody): ConfigBody['settings'][number] {
  const [first] = body.settings;
  assert.ok(first !== undefined && body.settings.length === 1);
  return first;
}

describe('configBody', () => {
  it('serves the team, its zone and its priorities, and no teams to join', () => {
    const body = bodyOf([], { timeZone: 'Asia/Jerusalem', priorities: ['p0', 'p1'] });
    assert.deepEqual(body, { team: 'app', teams: [], timeZone: 'Asia/Jerusalem', priorities: ['p0', 'p1'], settings: [], cuts: [] });
    assert.deepEqual(Object.keys(body), ['team', 'teams', 'timeZone', 'priorities', 'settings', 'cuts']);
  });

  it('serves a run with no team as team null and the teams to join', () => {
    const body = bodyOf([], { team: null, teams: ['app', 'web'] });
    assert.deepEqual([body.team, body.teams], [null, ['app', 'web']]);
  });

  it('serves a row with every field, null where the key has none, in one order', () => {
    const served = only(bodyOf([row()]));
    assert.deepEqual(Object.keys(served), FIELDS);
    assert.deepEqual(served, {
      path: 'messages.maxLines',
      group: 'messages',
      type: 'integer',
      items: null,
      enum: null,
      min: null,
      max: null,
      value: 12,
      default: 10,
      isDefault: false,
      meaning: 'How long a message may be.',
      editable: true,
      gatedBy: null,
      readOnly: null,
      problem: null,
      kept: null,
    });
  });

  it('serves the fields a row does carry as they are', () => {
    const served = only(
      bodyOf([row({ type: 'array', items: 'string', enum: ['a', 2, true, null], min: 1, max: 9, editable: false, gatedBy: 'budget', readOnly: 'owner gate: budget' })]),
    );
    assert.deepEqual(
      [served.items, served.enum, served.min, served.max, served.editable, served.gatedBy, served.readOnly],
      ['string', ['a', 2, true, null], 1, 9, false, 'budget', 'owner gate: budget'],
    );
  });

  it('serves a key with no value and no default as null in both', () => {
    const served = only(bodyOf([row({ value: undefined, default: undefined, isDefault: true })]));
    assert.deepEqual([served.value, served.default, served.isDefault], [null, null, true]);
  });

  it('serves every JSON value as it is', () => {
    const value = { on: true, count: 3, ratio: 0.5, none: null, list: ['a', ['b', 1], { deep: 'c' }], map: { alpha: { model: 'opus' } } };
    assert.deepEqual(only(bodyOf([row({ type: 'object', value, default: {} })])).value, value);
    for (const scalar of ['text', 0, false, null]) {
      assert.equal(only(bodyOf([row({ value: scalar })])).value, scalar);
    }
  });

  it('serves what JSON cannot hold as null', () => {
    const served = only(bodyOf([row({ value: [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 2], default: Number.NaN })]));
    assert.deepEqual([served.value, served.default], [[null, null, null, null, 2], null]);
  });

  it('cuts a secret-shaped value and lists the cut by the key path', () => {
    const body = bodyOf([row({ path: 'tools.note', type: 'string', value: SECRET, default: '' })]);
    assert.equal(only(body).value, CUT);
    assert.deepEqual(body.cuts, [{ id: 'tools.note', field: 'value', shape: SHAPE }]);
  });

  it('cuts each element of a list by itself, and each text inside an object', () => {
    const body = bodyOf([
      row({ path: 'tools.list', type: 'array', value: ['plain', SECRET, 'after'], default: [] }),
      row({ path: 'tools.map', type: 'object', value: { alpha: { note: SECRET, model: 'opus' }, list: [{ deep: SECRET }] }, default: {} }),
    ]);
    assert.deepEqual(body.settings[0]?.value, ['plain', CUT, 'after']);
    assert.deepEqual(body.settings[1]?.value, { alpha: { note: CUT, model: 'opus' }, list: [{ deep: CUT }] });
    assert.deepEqual(body.cuts, [
      { id: 'tools.list', field: 'value', shape: SHAPE },
      { id: 'tools.map', field: 'value', shape: SHAPE },
      { id: 'tools.map', field: 'value', shape: SHAPE },
    ]);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });

  it('leaves out a map entry whose key is secret-shaped, and lists the cut under key', () => {
    const body = bodyOf([row({ path: 'launch', type: 'object', value: { alpha: { model: 'opus' }, [SECRET]: { model: 'sonnet' } }, default: {} })]);
    assert.deepEqual(only(body).value, { alpha: { model: 'opus' } });
    assert.deepEqual(body.cuts, [{ id: 'launch', field: 'key', shape: SHAPE }]);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });

  it('scans the default as it scans the value', () => {
    const body = bodyOf([row({ path: 'tools.note', type: 'array', value: [], default: [SECRET, { [SECRET]: 1, kept: 'a' }] })]);
    assert.deepEqual(only(body).default, [CUT, { kept: 'a' }]);
    assert.deepEqual(body.cuts, [
      { id: 'tools.note', field: 'default', shape: SHAPE },
      { id: 'tools.note', field: 'key', shape: SHAPE },
    ]);
  });

  it('serves a key that names where a secret is kept without its value, with one fixed note', () => {
    const body = bodyOf([row({ path: 'alerts.pageWebhookFile', type: 'string', value: 'D:/keys/page.env', default: '', served: 'location' })]);
    const served = only(body);
    assert.deepEqual([served.value, served.default, served.isDefault, served.kept], [null, '', false, KEPT_NOTE]);
    assert.ok(!JSON.stringify(body).includes('page.env'));
    assert.deepEqual(body.cuts, []);
  });

  it('lists no cut for the value of a kept key, since it is never looked at', () => {
    const body = bodyOf([row({ path: 'alerts.pageWebhookKey', type: 'string', value: SECRET, default: '', served: 'location' })]);
    assert.equal(only(body).value, null);
    assert.deepEqual(body.cuts, []);
  });

  it('serves one fixed text for a problem, never the check\'s own words', () => {
    const served = only(bodyOf([row({ value: SECRET, problem: `must be an integer, got "${SECRET}"` })]));
    assert.equal(served.problem, SETTING_PROBLEM);
    assert.ok(!JSON.stringify(served).includes(SECRET));
  });

  it('serves the schema\'s own texts unscanned: they are teamrig\'s, and a cut would hide a key\'s meaning', () => {
    const body = bodyOf([row({ meaning: `Such as ${SECRET}.`, enum: [SECRET], readOnly: SECRET, gatedBy: SECRET })]);
    const served = only(body);
    assert.deepEqual([served.meaning, served.enum, served.readOnly, served.gatedBy], [`Such as ${SECRET}.`, [SECRET], SECRET, SECRET]);
    assert.deepEqual(body.cuts, []);
  });

  it('cuts a secret-shaped priority name', () => {
    const body = bodyOf([], { priorities: ['p0', SECRET] });
    assert.deepEqual(body.priorities, ['p0', CUT]);
    assert.deepEqual(body.cuts, [{ id: 'register.priorities', field: 'name', shape: SHAPE }]);
  });

  it('keeps the rows in the order it is handed', () => {
    const body = bodyOf([row({ path: 'b.two' }), row({ path: 'a.one' })]);
    assert.deepEqual(
      body.settings.map((served) => served.path),
      ['b.two', 'a.one'],
    );
  });
});
