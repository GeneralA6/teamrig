import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * No teamrig code runs taskkill. `taskkill /T` links a process to any older one that held its parent's id, so a root
 * that reused a long-ended process's id ends every program that one started: a spec that ran it on the host ended
 * every Windows Terminal tab (T2336). `taskkill /PID` alone ends whatever process holds the id by then, which on
 * Windows can be another program a few milliseconds after the listed one ended (T1562). A tree or a process ends
 * through the start-checked sweep of src/delivery/tree-kill.ts, or through the handle of a process this one holds.
 */

/** A string that names taskkill as the program to run. */
const PROGRAM = /^taskkill(\.exe)?$/i;
/** Command text that runs taskkill with a flag, as a shell line would. */
const COMMAND = /\btaskkill(\.exe)?\s+\//i;
/** The files the scan reads: TypeScript and JavaScript sources. */
const SOURCES = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
/** Folders the scan never enters: installed packages and built output. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** One string in code that runs taskkill, with its 1-based line. */
interface TaskkillUse {
  readonly line: number;
  readonly text: string;
}

/** A string's text, a template's with each substitution as one word; undefined for any other node. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('x');
  }
  return undefined;
}

/** The strings of a source that run taskkill; comments are no tokens, so a comment naming it is not one. */
function taskkillUses(fileName: string, source: string): TaskkillUse[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: TaskkillUse[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== undefined && (PROGRAM.test(text.trim()) || COMMAND.test(text))) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every source file under `dir`, but those in a skipped folder. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : sourcesUnder(path);
    }
    return entry.isFile() && SOURCES.has(extname(entry.name)) ? [path] : [];
  });
}

describe('taskkillUses', () => {
  it('finds taskkill named as a program, as a spawn or a program runner gets it', () => {
    const source = [
      "spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);",
      "await run({ program: 'TASKKILL.EXE', args: ['/PID', '7'] });",
    ].join('\n');
    assert.deepEqual(taskkillUses('a.ts', source), [
      { line: 1, text: 'taskkill' },
      { line: 2, text: 'TASKKILL.EXE' },
    ]);
  });

  it('finds taskkill in command text, a template with a substitution too', () => {
    const source = ['execSync(`taskkill /PID ${pid} /T /F`);', "exec('cmd /c taskkill /IM node.exe');"].join('\n');
    assert.deepEqual(
      taskkillUses('a.ts', source).map((use) => use.line),
      [1, 2],
    );
  });

  it('leaves a comment, a regular expression and prose that names taskkill without running it', () => {
    const source = [
      '// taskkill /T /F would end strangers (T2336).',
      '/** The sweep, never `taskkill /T`. */',
      'assert.doesNotMatch(script, /taskkill/);',
      "it('ends the tree without taskkill', () => undefined);",
      "const label = 'taskkill-free';",
    ].join('\n');
    assert.deepEqual(taskkillUses('a.ts', source), []);
  });

  it('reads JavaScript sources too', () => {
    assert.equal(taskkillUses('a.cjs', "require('child_process').spawnSync('taskkill', ['/PID', '7']);").length, 1);
  });
});

describe('teamrig code', () => {
  it('runs taskkill nowhere: a tree ends through the start-checked sweep (T2336)', () => {
    const files = [...sourcesUnder(join(ROOT, 'src')), ...sourcesUnder(join(ROOT, 'tools'))].filter((path) => path !== SELF);
    assert.ok(files.length > 100, `the scan read only ${files.length} files`);
    const found = files.flatMap((path) =>
      taskkillUses(path, readFileSync(path, 'utf8')).map((use) => `${relative(ROOT, path)}:${use.line} ${JSON.stringify(use.text)}`),
    );
    assert.deepEqual(found, []);
  });
});
