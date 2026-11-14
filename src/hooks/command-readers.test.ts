import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every hook that reads a shell tool call's command weighs each text bash may run (T2332). On Windows Claude Code
 * hands a Bash line to Git Bash through a Windows command line that halves backslash runs, so a guard reading only
 * the line as written can pass what bash then runs (core/bash-tool-readings.ts). A guard takes its readings from
 * `toolCommandReadings`, or a route from `toolRouteOf`, which holds only when every reading is that route; a reader
 * whose verdict cannot change under the halving sits in EXEMPT with the reason it holds. The spec fails on a new
 * reader with neither, and on an exemption whose file no longer reads a command.
 */

/** The functions that hand a reader every text a shell call may run. */
const READINGS_IMPORTS: ReadonlySet<string> = new Set(['toolCommandReadings', 'toolRouteOf']);

/** Readers whose verdict is the same in every reading, by the path under src/ with `/` separators, with why. */
const EXEMPT: Readonly<Record<string, string>> = {
  'hooks/pass-record-guard.ts':
    'matches the pass-record folder name with word bounds; halving keeps at least one backslash of each run, so the name and its bounds read alike in every reading',
  'hooks/prompt-refuse.ts': 'reads the command only for the refusal log line; the call is refused in every reading',
  'tabs/need.ts': "shows the asked command in another tab's band; it decides nothing",
};

/** Guards the scan must find among the readers, so a scan gone blind fails instead of passing on nothing. */
const KNOWN_GUARDS: readonly string[] = [
  'hooks/db-write-guard.ts',
  'hooks/exec-guard.ts',
  'hooks/package-guard.ts',
  'hooks/push-guard.ts',
  'hooks/readonly-shell.ts',
  'hooks/secret-guard.ts',
  'cli/commands/hook-route-context.ts',
];

const SOURCES = new Set(['.ts', '.mts', '.cts']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const SRC = fileURLToPath(new URL('..', import.meta.url));

/** What one source says about the command it reads. */
interface CommandReading {
  /** Names both `tool_input` and `command` as strings: it reads a hook payload's command. */
  readonly readsCommand: boolean;
  /** Imports a function that gives every reading. */
  readonly importsReadings: boolean;
}

/** Reads a source's string literals and imports; comments are no tokens, so prose naming a field is not a read. */
function commandReadingOf(fileName: string, source: string): CommandReading {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const strings = new Set<string>();
  let importsReadings = false;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.add(node.text);
    }
    if (ts.isImportSpecifier(node) && READINGS_IMPORTS.has((node.propertyName ?? node.name).text)) {
      importsReadings = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { readsCommand: strings.has('tool_input') && strings.has('command'), importsReadings };
}

/** Every non-test TypeScript source under `dir`, but those in a skipped folder. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : sourcesUnder(path);
    }
    return entry.isFile() && SOURCES.has(extname(entry.name)) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The command readers under src/, by path with `/` separators, with whether each imports the readings. */
function commandReaders(): Map<string, boolean> {
  const readers = new Map<string, boolean>();
  for (const path of sourcesUnder(SRC)) {
    const reading = commandReadingOf(path, readFileSync(path, 'utf8'));
    if (reading.readsCommand) {
      readers.set(relative(SRC, path).split(sep).join('/'), reading.importsReadings);
    }
  }
  return readers;
}

describe('commandReadingOf', () => {
  it('finds a read of the payload command and the readings import', () => {
    const source = [
      "import { toolCommandReadings } from '../core/bash-tool-readings.ts';",
      "const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');",
    ].join('\n');
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
  });

  it('finds toolRouteOf imported under another name', () => {
    const source = "import { toolRouteOf as routeOf } from '../permissions/sanctioned.ts';\nconst f = ['tool_input', 'command'];";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
  });

  it('finds a read that weighs only the line as written', () => {
    const source = "const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: false });
  });

  it('leaves a source naming the fields only in comments, or only one of them', () => {
    assert.equal(commandReadingOf('a.ts', "// reads tool_input's 'command'\nconst a = 1;").readsCommand, false);
    assert.equal(commandReadingOf('a.ts', "const hook = { type: 'command', command: 'x' };").readsCommand, false);
  });
});

describe('teamrig hooks', () => {
  const readers = commandReaders();

  it('finds every known guard among the command readers, so the scan is not blind', () => {
    assert.deepEqual(
      KNOWN_GUARDS.filter((path) => !readers.has(path)),
      [],
    );
  });

  it('weigh every text bash may run wherever they read a command (T2332)', () => {
    const unweighed = [...readers].filter(([path, imports]) => !imports && EXEMPT[path] === undefined).map(([path]) => path);
    assert.deepEqual(unweighed, [], 'import toolCommandReadings or toolRouteOf, or add the file to EXEMPT with why its verdict cannot change');
  });

  it('keep no exemption for a file that no longer reads a command, or that weighs every reading now', () => {
    const stale = Object.keys(EXEMPT).filter((path) => readers.get(path) !== false);
    assert.deepEqual(stale, []);
  });
});
