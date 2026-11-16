import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every program teamrig starts is hidden on Windows (T3369). A detached queue run has no console, so a program it
 * starts without `windowsHide` gets a new console of its own, and with Windows Terminal as the default terminal that
 * console opens as a visible tab: one per git call, dozens when many runs start at once. A call whose window is the
 * point says so on the line above it, `// Shown on purpose: <why>`.
 */

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOWN = '// Shown on purpose:';
const HIDDEN = /\bwindowsHide:\s*true\b/;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g;
const WHOLE_IMPORT = /import\s+(?!type\b)(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*'node:child_process'/;

/** The functions a file imports from node:child_process to call, type imports left out. */
function startersOf(text: string): readonly string[] {
  return [...text.matchAll(NAMED_IMPORT)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '))
      .map((name) => name.split(/\s+as\s+/).at(-1) ?? name),
  );
}

/** The call's code from the parenthesis at `open` to the one that closes it, the text of its strings left out. */
function argumentsOf(text: string, open: number): string {
  let code = '';
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char === "'" || char === '"' || char === '`') {
      for (at += 1; at < text.length && text[at] !== char; at += 1) {
        at += text[at] === '\\' ? 1 : 0;
      }
      code += `${char}${char}`;
      continue;
    }
    code += char;
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (depth === 0) {
      return code;
    }
  }
  return code;
}

/** `file:line` of each call in `text` that starts a program neither hidden nor marked shown on purpose. */
export function unhiddenCalls(file: string, text: string): readonly string[] {
  if (WHOLE_IMPORT.test(text)) {
    return [`${file}: imports node:child_process whole; import the functions by name so each call is checked`];
  }
  const lines = text.split('\n');
  return startersOf(text).flatMap((name) =>
    [...text.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g'))].flatMap((match) => {
      const open = match.index + match[0].length - 1;
      const line = text.slice(0, match.index).split('\n').length;
      const own = (lines[line - 1] ?? '').trim();
      const above = (lines[line - 2] ?? '').trim();
      const comment = own.startsWith('//') || own.startsWith('*');
      return comment || above.startsWith(SHOWN) || HIDDEN.test(argumentsOf(text, open)) ? [] : [`${file}:${line} ${name}`];
    }),
  );
}

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('every program teamrig starts is hidden (T3369)', () => {
  it('starts no program in src without windowsHide, but those shown on purpose', () => {
    const found = sourceFiles(SRC).flatMap((path) => unhiddenCalls(relative(SRC, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')));
    assert.deepEqual(found, []);
  });

  it('finds a git run started with no windowsHide, as a detached queue run did', () => {
    const text = ["import { spawnSync } from 'node:child_process';", "const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });"].join('\n');
    assert.deepEqual(unhiddenCalls('git-run.ts', text), ['git-run.ts:2 spawnSync']);
  });

  it('passes a call hidden on any of its lines, and one marked shown on purpose', () => {
    const text = [
      "import { execFile, spawn as start } from 'node:child_process';",
      'execFile(file, args, {',
      "  stdio: ['ignore', 'pipe', 'pipe'],",
      '  windowsHide: true,',
      '});',
      '// Shown on purpose: the new window.',
      "start(command, args, { detached: true, stdio: 'ignore' });",
    ].join('\n');
    assert.deepEqual(unhiddenCalls('launch.ts', text), []);
  });

  it('reads a call under an alias, and windowsHide inside a string is no hiding', () => {
    const text = ["import { spawn as start } from 'node:child_process';", "start('git', ['log', 'windowsHide: true'], { cwd });"].join('\n');
    assert.deepEqual(unhiddenCalls('alias.ts', text), ['alias.ts:2 start']);
  });

  it('refuses a whole-module import, whose calls it could not tell apart', () => {
    assert.deepEqual(unhiddenCalls('whole.ts', "import * as child from 'node:child_process';"), [
      'whole.ts: imports node:child_process whole; import the functions by name so each call is checked',
    ]);
  });
});
