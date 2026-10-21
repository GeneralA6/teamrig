import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HIRE_FLAG_KINDS } from '../../src/hiring/due.ts';
import { FLAG_KINDS } from '../../src/register/check.ts';
import { SKILL_FLAG_KINDS } from '../../src/skills/lint.ts';

/**
 * The guide's check-flag reference (tasks.md, "## Check flags") held to the flags `teamrig check` raises: each of its
 * three tables lists exactly its kinds. They are compared sorted, since a table groups the flags for a reader while
 * the report orders them by urgency.
 */

const TASKS = readFileSync(fileURLToPath(new URL('../../plugins/teamrig/skills/teamrig-guide/tasks.md', import.meta.url)), 'utf8');
const ROW_KIND = /^\| `([A-Z][A-Z-]*)` \|/;

/** The guide's "## Check flags" section, up to the next `## ` heading. */
function checkFlagsSection(): string[] {
  const lines = TASKS.split(/\r?\n/);
  const start = lines.indexOf('## Check flags');
  assert.ok(start >= 0, 'tasks.md has no "## Check flags" section');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** The flag in the first cell of each row of the section's table headed `| <header> |`. */
function tableKinds(header: string): string[] {
  const section = checkFlagsSection();
  const start = section.findIndex((line) => line.startsWith(`| ${header} |`));
  assert.ok(start >= 0, `"## Check flags" has no table headed "${header}"`);
  const rows: string[] = [];
  for (const line of section.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(ROW_KIND.exec(line)?.[1] ?? `a row with no flag: ${line.slice(0, 40)}`);
  }
  return rows.sort();
}

describe('the guide\'s check-flag tables', () => {
  it('list every flag teamrig check raises on a task, once', () => {
    assert.deepEqual(tableKinds('Flag'), [...FLAG_KINDS].sort());
  });

  it('list every hire flag, once', () => {
    assert.deepEqual(tableKinds('Hire flag'), [...HIRE_FLAG_KINDS].sort());
  });

  it('list every skill flag, once', () => {
    assert.deepEqual(tableKinds('Skill flag'), [...SKILL_FLAG_KINDS].sort());
  });
});
