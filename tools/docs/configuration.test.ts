import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocs } from './doc-check.ts';
import { CONFIG_DOC, loadConfigSchema, renderConfigReference } from './configuration.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The page's headings, `#` and `##`, without their marks. */
function headings(page: string): string[] {
  return [...page.matchAll(/^#{1,2} (.*)$/gm)].map((match) => match[1] ?? '');
}

/** The text of the section under `## heading`, up to the next one. */
function section(page: string, heading: string): string {
  const part = page.split(/^## /m).find((text) => text.startsWith(`${heading}\n`));
  assert.ok(part !== undefined, `no section ${heading}`);
  return part;
}

/** A section's table rows, without the head and its rule. */
function rows(page: string, heading: string): string[] {
  return section(page, heading)
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2);
}

describe('renderConfigReference', () => {
  it('says in words what each type of value may be', () => {
    const page = renderConfigReference({
      type: 'object',
      properties: {
        flag: { type: 'boolean', default: true, description: 'a flag' },
        count: { type: 'integer', minimum: 1, maximum: 99 },
        floor: { type: 'number', minimum: 0 },
        cap: { type: 'integer', maximum: 64 },
        word: { type: 'string', minLength: 1, maxLength: 260, pattern: '^a|b$' },
        short: { type: 'string', maxLength: 1 },
        mode: { enum: ['ask', 'deny'], default: 'ask' },
        model: { anyOf: [{ enum: ['best'] }, { type: 'string', pattern: '^claude-' }] },
        list: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string' } },
        bare: { type: 'array' },
        map: { type: 'object', propertyNames: { pattern: '^[a-z]+$' }, additionalProperties: { type: 'integer' } },
        free: { type: 'object' },
      },
    });
    assert.deepEqual(rows(page, 'Top level'), [
      '| `flag` | boolean | `true` | a flag |',
      '| `count` | integer (1 to 99) |  |  |',
      '| `floor` | number (at least 0) |  |  |',
      '| `cap` | integer (at most 64) |  |  |',
      '| `word` | string (1 to 260 characters, matching `^a\\|b$`) |  |  |',
      '| `short` | string (at most 1 character) |  |  |',
      '| `mode` | one of `"ask"`, `"deny"` | `"ask"` |  |',
      '| `model` | one of `"best"` or string (matching `^claude-`) |  |  |',
      '| `list` | array (1 to 8 items, unique) of string |  |  |',
      '| `bare` | array |  |  |',
      '| `map` | map from string (matching `^[a-z]+$`) to integer |  |  |',
      '| `free` | object |  |  |',
    ]);
    assert.deepEqual(headings(page), ['Configuration reference', 'Top level']);
  });

  it('draws a section per object that lists keys, depth first, each linked from its key', () => {
    const page = renderConfigReference({
      type: 'object',
      required: ['outer'],
      properties: {
        outer: {
          type: 'object',
          description: 'the outer one',
          required: ['inner'],
          properties: { inner: { type: 'object', properties: { leaf: { type: 'string' } } }, after: { type: 'boolean' } },
        },
        rows: { type: 'array', description: 'some rows', items: { type: 'object', properties: { id: { type: 'integer' } } } },
        byName: { type: 'object', description: 'by name', additionalProperties: { type: 'object', description: 'one named', properties: { share: { type: 'number' } } } },
        last: { type: 'string' },
      },
    });
    assert.deepEqual(headings(page), ['Configuration reference', 'Top level', '`outer`', '`outer.inner`', '`rows[]`', '`byName.*`']);
    assert.deepEqual(rows(page, 'Top level'), [
      '| `outer` (required) | [object](#outer) |  | the outer one |',
      '| `rows` | array of [object](#rows) |  | some rows |',
      '| `byName` | map from string to [object](#byname) |  | by name |',
      '| `last` | string |  |  |',
    ]);
    assert.deepEqual(rows(page, '`outer`'), ['| `inner` (required) | [object](#outerinner) |  |  |', '| `after` | boolean |  |  |']);
    assert.match(section(page, '`outer`'), /^`outer`\n\nthe outer one\n\n\| Key/);
    assert.match(section(page, '`rows[]`'), /^`rows\[\]`\n\nsome rows\n\n\| Key/, 'an item object without words takes its array\'s');
    assert.match(section(page, '`byName.*`'), /^`byName\.\*`\n\none named\n\n\| Key/, 'a map value object keeps its own words');
    assert.match(section(page, '`outer.inner`'), /^`outer\.inner`\n\n\| Key/, 'a section without words has no paragraph');
  });

  it('escapes Markdown outside code spans and pipes in every cell', () => {
    const page = renderConfigReference({
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'Files like **/*.md go to <team>-<id> with a_b ~x \\ and `<kept> **/raw`' },
        pipe: { type: 'string', pattern: 'a|b', default: 'x|y' },
        tick: { type: 'string', default: 'a`b' },
      },
    });
    assert.deepEqual(rows(page, 'Top level'), [
      '| `glob` | string |  | Files like \\*\\*/\\*.md go to \\<team>-\\<id> with a\\_b \\~x \\\\ and `<kept> **/raw` |',
      '| `pipe` | string (matching `a\\|b`) | `"x\\|y"` |  |',
      '| `tick` | string | `` "a`b" `` |  |',
    ]);
  });

  it('links a shared type to its row under Shared types', () => {
    const page = renderConfigReference({
      type: 'object',
      $defs: { sessionName: { type: 'string', pattern: '^[a-z]+$', description: 'a session id' } },
      properties: { lead: { $ref: '#/$defs/sessionName' } },
    });
    assert.deepEqual(rows(page, 'Top level'), ['| `lead` | [session name](#shared-types) |  |  |']);
    assert.deepEqual(rows(page, 'Shared types'), ['| session name | string (matching `^[a-z]+$`) | a session id |']);
    assert.deepEqual(headings(page).at(-1), 'Shared types');
  });

  it('refuses a schema it cannot draw in full', () => {
    const draw = (properties: Record<string, unknown>) => () => renderConfigReference({ type: 'object', properties });
    assert.throws(draw({ n: { type: 'integer', exclusiveMinimum: 0 } }), /the schema keyword exclusiveMinimum at n is not drawn/);
    assert.throws(draw({ n: { description: 'no type' } }), /n has no type the page can draw/);
    assert.throws(draw({ m: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } } }), /m lists keys and is a map/);
    assert.throws(draw({ r: { $ref: '#/$defs/missing' } }), /r refers to #\/\$defs\/missing, which is not in \$defs/);
    assert.throws(
      draw({ ab: { type: 'object', properties: { x: { type: 'string' } } }, a: { type: 'object', properties: { b: { type: 'object', properties: { y: { type: 'string' } } } } } }),
      /the headings `ab` and `a.b` share the anchor #ab/,
    );
  });

  it('draws the real schema into a page whose every link resolves', () => {
    const page = renderConfigReference(loadConfigSchema());
    assert.ok(page.startsWith('# Configuration reference\n\n'));
    assert.ok(page.endsWith('|\n') && !page.endsWith('\n\n'), 'the page ends in one newline');
    const drawn = new Set(headings(page));
    for (const heading of ['Top level', '`ruleConflicts[]`', '`delivery.repos.*.deploy.checks[]`', '`budget.sessions.*`', '`launch.*`', 'Shared types']) {
      assert.ok(drawn.has(heading), `no section ${heading}`);
    }
    assert.match(rows(page, 'Top level').join('\n'), /^\| `sessions` \(required\) \| array \(unique\) of \[session name\]\(#shared-types\) \|/m);
    const setup = 'docs/setup-by-hand.md';
    const report = checkDocs(
      [
        { path: CONFIG_DOC, text: page },
        { path: setup, text: readFileSync(join(ROOT, setup), 'utf8') },
      ],
      (path) => existsSync(join(ROOT, path)),
    );
    assert.deepEqual(report.problems, []);
    assert.ok(report.links > 50, `only ${report.links} links`);
  });
});
