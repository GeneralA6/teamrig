import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { LEAD_KEYS } from './lead-keys.ts';
import { OWNER_GATED_KEYS } from './owner-gated.ts';
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

/** The synthetic schema's lead list: register.unset is left off it, as a key added later would be. */
const LEAD_LIST: ReadonlySet<string> = new Set(['messages.maxLines', 'messages.mode', 'messages.tags', 'focus.wip', 'budget.targetPct']);

describe('settingRows', () => {
  const rows = settingRows(SCHEMA, RAW, [{ path: 'register.priorities[1].name', message: 'expected a name' }], LEAD_LIST);

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

  it('keeps a key off the lead list read-only, the owner deciding it; a gate wins over the list', () => {
    const unset = rowAt(rows, 'register.unset');
    assert.deepEqual([unset.editable, unset.gatedBy, unset.readOnly], [false, undefined, 'not on the list of keys the lead may set: the owner decides it, in config.json']);
    assert.equal(rowAt(rows, 'budget.targetPct').editable, false);
    const unlisted = settingRows(SCHEMA, RAW, [], new Set());
    assert.deepEqual(unlisted.filter((row) => row.editable).map((row) => row.path), []);
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
    // Every guard by its name, not a list of today's guards: dbWriteGuard was once left off such a list and read editable.
    const gatedGroups = ['budget', 'burst', 'permissions', 'prompts', 'exec', 'readonlyShell', 'leadBoundary', 'ownerGates'];
    const gated = rows.filter((row) => gatedGroups.includes(row.group) || row.group.endsWith('Guard'));
    assert.ok(gated.some((row) => row.group === 'dbWriteGuard'));
    assert.deepEqual(gated.filter((row) => row.editable || row.gatedBy === undefined).map((row) => row.path), []);
    assert.equal(rowAt(rows, 'focus.allocation').gatedBy, 'budget');
  });

  it('leaves a plain key editable at its default', () => {
    const maxLines = rowAt(rows, 'messages.maxLines');
    assert.deepEqual([maxLines.editable, maxLines.value, maxLines.isDefault, maxLines.min, maxLines.max], [true, 10, true, 3, 50]);
  });

  it('names a real, editable key in every lead list entry, so no entry outlives its key or hides under a gate', () => {
    const editable = new Set(rows.filter((row) => row.editable).map((row) => row.path));
    assert.deepEqual([...LEAD_KEYS].filter((path) => !editable.has(path)), []);
    assert.deepEqual([...editable].filter((path) => !LEAD_KEYS.has(path)), []);
  });

  it('gates the keys that run a program, page the owner, grant rights or share the host (security verdict T2899)', () => {
    const gates = new Map([
      ['refresh.endCommand', 'permissions'],
      ['register.ownerSource', 'permissions'],
      ['register.secretPatterns', 'permissions'],
      ['skills.forbidFrontmatter', 'permissions'],
      ['commits.gate', 'permissions'],
      ['hiring.policy', 'budget'],
    ]);
    for (const [path, gate] of gates) {
      assert.deepEqual([path, rowAt(rows, path).gatedBy, rowAt(rows, path).editable], [path, gate, false]);
    }
    const byGroup = (prefix: string): readonly SettingRow[] => rows.filter((row) => row.path.startsWith(prefix));
    for (const [prefix, gate] of [['securityGates', 'permissions'], ['alerts.', 'permissions'], ['delivery.queue.', 'resource changes'], ['open.headroom.', 'resource changes'], ['open.idle.', 'resource changes']] as const) {
      assert.ok(byGroup(prefix).length > 0, `no rows under ${prefix}`);
      assert.deepEqual(byGroup(prefix).filter((row) => row.gatedBy !== gate || row.editable).map((row) => row.path), []);
    }
  });

  it('gates every key the config guard refuses a session writing, read from the one list both use (#1470)', () => {
    for (const keyPath of OWNER_GATED_KEYS) {
      const path = keyPath.join('.');
      const under = rowsUnder(rows, path);
      assert.ok(under.length > 0, `no rows at or under ${path}`);
      assert.deepEqual(under.filter((row) => row.gatedBy === undefined || row.editable).map((row) => row.path), [], path);
    }
    // A map's entries are under its key: one repository's ship tool is as gated as the map of them.
    assert.deepEqual([rowAt(rows, 'delivery.repos').gatedBy, rowAt(rows, 'delivery.passEnv').gatedBy, rowAt(rows, 'github.owners').gatedBy], ['permissions', 'permissions', 'permissions']);
  });

  it('keeps the folders teamrig keeps records in read-only', () => {
    for (const path of ['paths.state', 'paths.inbox', 'paths.skills', 'delivery.dir', 'refresh.handoverDir']) {
      assert.deepEqual([path, rowAt(rows, path).editable, rowAt(rows, path).readOnly], [path, false, 'a folder teamrig keeps records in: set it when the team is made, or in config.json']);
    }
  });
});
