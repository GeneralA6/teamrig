import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { rowsUnder, settingRows, type SettingRow } from './settings.ts';

const SCHEMA: JsonRecord = {
  $defs: { sessionName: { description: 'A session id.', type: 'string', pattern: '^[a-z]+$' } },
  properties: {
    $schema: { type: 'string' },
    configVersion: { description: 'The format.', type: 'integer', default: 3 },
    sessions: { description: 'Who is on the team.', type: 'array', items: { $ref: '#/$defs/sessionName' } },
    roles: { type: 'object', properties: { lead: { description: 'The lead.', $ref: '#/$defs/sessionName' } } },
    messages: {
      description: 'Messages.',
      type: 'object',
      properties: {
        maxLines: { description: 'The longest message.', type: 'integer', minimum: 3, maximum: 50, default: 10 },
        mode: { description: 'How sends go.', enum: ['hold', 'send'], default: 'hold' },
        tags: { description: 'Tags.', type: 'array', items: { type: 'string' }, default: ['a'] },
      },
    },
    register: {
      type: 'object',
      properties: {
        priorities: { description: 'Levels.', type: 'array', items: { type: 'object' } },
        aliases: { description: 'Names by alias.', type: 'object', additionalProperties: { type: 'string' } },
        unset: { description: 'No default.', type: 'number' },
      },
    },
    budget: { type: 'object', properties: { targetPct: { description: 'The week target.', type: 'number', default: 99.5 } } },
    focus: {
      type: 'object',
      properties: {
        allocation: { description: 'Shares.', type: 'object', additionalProperties: { type: 'number' } },
        wip: { description: 'The WIP limit.', type: 'integer', default: 1 },
      },
    },
  },
};

const RAW: JsonRecord = {
  $schema: './config.schema.json',
  configVersion: 3,
  sessions: ['lead', 'alpha'],
  roles: { lead: 'lead' },
  messages: { maxLines: 12, tags: ['a'] },
  register: { priorities: [{ name: 'p0' }, { name: '' }] },
};

function rowAt(rows: readonly SettingRow[], path: string): SettingRow {
  const row = rows.find((each) => each.path === path);
  assert.ok(row, `no row ${path}`);
  return row;
}

describe('settingRows', () => {
  const rows = settingRows(SCHEMA, RAW, [{ path: 'register.priorities[1].name', message: 'expected a name' }]);

  it('lists every leaf key in the schema order, objects walked into and $schema left out', () => {
    assert.deepEqual(
      rows.map((row) => row.path),
      [
        'configVersion',
        'sessions',
        'roles.lead',
        'messages.maxLines',
        'messages.mode',
        'messages.tags',
        'register.priorities',
        'register.aliases',
        'register.unset',
        'budget.targetPct',
        'focus.allocation',
        'focus.wip',
      ],
    );
    assert.equal(rowAt(rows, 'messages.maxLines').group, 'messages');
  });

  it('shows the written value against the default, a missing one as its default', () => {
    assert.deepEqual(rowAt(rows, 'messages.maxLines'), {
      path: 'messages.maxLines',
      group: 'messages',
      type: 'integer',
      min: 3,
      max: 50,
      value: 12,
      default: 10,
      isDefault: false,
      meaning: 'The longest message.',
      editable: true,
    });
    assert.deepEqual(rowAt(rows, 'messages.mode'), {
      path: 'messages.mode',
      group: 'messages',
      type: 'string',
      enum: ['hold', 'send'],
      value: 'hold',
      default: 'hold',
      isDefault: true,
      meaning: 'How sends go.',
      editable: true,
    });
    const tags = rowAt(rows, 'messages.tags');
    assert.deepEqual([tags.type, tags.items, tags.isDefault, tags.editable], ['array', 'string', true, true]);
    const unset = rowAt(rows, 'register.unset');
    assert.deepEqual(['value' in unset, 'default' in unset, unset.isDefault], [false, false, true]);
  });

  it('keeps the roster and the format version read-only, naming what changes them', () => {
    for (const path of ['sessions', 'roles.lead']) {
      assert.deepEqual([rowAt(rows, path).editable, rowAt(rows, path).readOnly], [false, 'the roster: changed only by teamrig hire, retire, rename, promote and demote']);
    }
    assert.deepEqual(rowAt(rows, 'roles.lead').meaning, 'The lead.');
    assert.equal(rowAt(rows, 'roles.lead').type, 'string');
    assert.deepEqual([rowAt(rows, 'configVersion').editable, rowAt(rows, 'configVersion').readOnly], [false, 'the config format: teamrig config migrate writes it']);
  });

  it('keeps maps and lists of records read-only, with the problem found in them', () => {
    const priorities = rowAt(rows, 'register.priorities');
    assert.deepEqual([priorities.editable, priorities.items, priorities.problem], [false, 'object', 'expected a name']);
    assert.match(priorities.readOnly ?? '', /^a list of records or a map/);
    assert.equal(rowAt(rows, 'register.aliases').editable, false);
    assert.equal(rowAt(rows, 'messages.maxLines').problem, undefined);
  });

  it('marks owner-gated keys with their gate, a sibling of a gated key left editable', () => {
    assert.deepEqual([rowAt(rows, 'budget.targetPct').gatedBy, rowAt(rows, 'budget.targetPct').readOnly, rowAt(rows, 'budget.targetPct').editable], ['budget', 'owner gate: budget', false]);
    assert.equal(rowAt(rows, 'focus.allocation').gatedBy, 'budget');
    assert.deepEqual([rowAt(rows, 'focus.wip').gatedBy, rowAt(rows, 'focus.wip').editable], [undefined, true]);
  });

  it('picks the rows at a path or under it, none for an unknown one', () => {
    assert.deepEqual(rowsUnder(rows, 'messages').map((row) => row.path), ['messages.maxLines', 'messages.mode', 'messages.tags']);
    assert.deepEqual(rowsUnder(rows, 'messages.mode').map((row) => row.path), ['messages.mode']);
    assert.deepEqual(rowsUnder(rows, 'message'), []);
  });
});

describe('settingRows over the shipped schema', async () => {
  const schema: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8'));
  assert.ok(isRecord(schema));
  const rows = settingRows(schema, {}, []);

  it('lists each key once, under every top-level key but $schema', () => {
    const paths = rows.map((row) => row.path);
    assert.equal(new Set(paths).size, paths.length);
    const properties = isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
    assert.deepEqual(new Set(rows.map((row) => row.group)), new Set(properties.filter((key) => key !== '$schema')));
  });

  it('gives every row a meaning and keeps every guard, the budget and the permissions owner-gated', () => {
    assert.deepEqual(rows.filter((row) => row.meaning === '').map((row) => row.path), []);
    const gatedGroups = ['budget', 'permissions', 'pushGuard', 'secretGuard', 'packageGuard', 'commitGuard', 'pickerGuard', 'exec', 'readonlyShell', 'leadBoundary', 'ownerGates'];
    const gated = rows.filter((row) => gatedGroups.includes(row.group));
    assert.ok(gated.length > 0);
    assert.deepEqual(gated.filter((row) => row.editable || row.gatedBy === undefined).map((row) => row.path), []);
    assert.equal(rowAt(rows, 'focus.allocation').gatedBy, 'budget');
  });

  it('leaves a plain key editable at its default', () => {
    const maxLines = rowAt(rows, 'messages.maxLines');
    assert.deepEqual([maxLines.editable, maxLines.value, maxLines.isDefault, maxLines.min, maxLines.max], [true, 10, true, 3, 50]);
  });
});
