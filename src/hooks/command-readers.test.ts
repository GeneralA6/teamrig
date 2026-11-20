import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every hook that reads a shell tool call's command weighs each text bash may run (T2332). On Windows Claude Code
 * hands a Bash line to Git Bash through a Windows command line that halves backslash runs, so a guard reading only
 * the line as written can pass what bash then runs (the host adapter's bash-readings.ts). A guard takes its readings
 * from the shell call the host port hands it (`readings`); a route from `shellRouteOf` or a service role's call from
 * `shellRoleCallOf`, each of which holds only when every reading is that route or call; a reader whose verdict cannot
 * change under the halving sits in EXEMPT with the reason it holds. A source that reads the command off the hook
 * payload itself, or off the call's input as the host sent it, has no readings to take, so it is a reader with none.
 * The spec fails on a new reader with none, and on an exemption whose file no longer reads a command.
 */

/** The functions that judge a shell call in every text it may run. */
const READINGS_IMPORTS: ReadonlySet<string> = new Set(['shellRouteOf', 'shellRoleCallOf']);

/** Readers whose verdict is the same in every reading, by the path under src/ with `/` separators, with why. */
const EXEMPT: Readonly<Record<string, string>> = {
  'budget/line.ts': "reads a tool use's command off a transcript line or a call to count a turn's work for the budget and the loop nudge; it allows or refuses no call",
  'hooks/cd-compound.ts':
    "refuses only, never allows: a line it lets go meets Claude Code's own prompt, a refused one its rerun form, so no reading lets a line run unchecked",
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
  'hooks/service-role-guard.ts',
  'cli/commands/hook-role-allow.ts',
  'cli/commands/hook-route-context.ts',
];

const SOURCES = new Set(['.ts', '.mts', '.cts']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const SRC = fileURLToPath(new URL('..', import.meta.url));

/** What one source says about the command it reads. */
interface CommandReading {
  /**
   * It reads a shell call's command: off a hook payload, naming both `tool_input` and `command` as strings; off the
   * call the host port hands it, narrowing its kind to `shell` and reading the member `command`; or off that call's
   * input as the host sent it, reading the member `input` and naming `command` as a string.
   */
  readonly readsCommand: boolean;
  /** Imports a function that gives every reading, or reads the shell call's `readings`. */
  readonly importsReadings: boolean;
}

/** The member a node reads off a value: `call.command`, or `command` in `const { command } = call`. */
function memberOf(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isBindingElement(node)) {
    const name = node.propertyName ?? node.name;
    return ts.isIdentifier(name) ? name.text : undefined;
  }
  return undefined;
}

function isShellKind(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && node.text === 'shell';
}

/**
 * True where a call is narrowed to the shell kind: `call.kind === 'shell'`, `call?.kind !== 'shell'` or a
 * `case 'shell':`. The word alone is no narrowing: a source may name a thing `shell` and read some other `command`.
 */
function narrowsToShell(node: ts.Node): boolean {
  if (ts.isCaseClause(node)) {
    return isShellKind(node.expression);
  }
  if (!ts.isBinaryExpression(node)) {
    return false;
  }
  const sides = [node.left, node.right];
  return sides.some(isShellKind) && sides.some((side) => ts.isPropertyAccessExpression(side) && side.name.text === 'kind');
}

/** Reads a source's string literals, members and imports; comments are no tokens, so prose naming a field is not a read. */
function commandReadingOf(fileName: string, source: string): CommandReading {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const strings = new Set<string>();
  const members = new Set<string>();
  let importsReadings = false;
  let narrowsShell = false;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.add(node.text);
    }
    narrowsShell ||= narrowsToShell(node);
    const member = memberOf(node);
    if (member !== undefined) {
      members.add(member);
    }
    if (ts.isImportSpecifier(node) && READINGS_IMPORTS.has((node.propertyName ?? node.name).text)) {
      importsReadings = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const offPayload = strings.has('tool_input') && strings.has('command');
  // A guard that reads only the readings, never the line as written, reads the command as much as one that reads both.
  const offCall = narrowsShell && (members.has('command') || members.has('readings'));
  // The input as the host sent it holds the line as written too, and a read of it takes none of the call's readings.
  const offInput = members.has('input') && strings.has('command');
  return { readsCommand: offPayload || offCall || offInput, importsReadings: importsReadings || members.has('readings') };
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
  it('finds a read of the payload command and the import that judges every reading', () => {
    const source = [
      "import { shellRouteOf } from '../permissions/sanctioned.ts';",
      "const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');",
    ].join('\n');
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
  });

  it('finds shellRouteOf imported under another name', () => {
    const source = "import { shellRouteOf as routeOf } from '../permissions/sanctioned.ts';\nconst f = ['tool_input', 'command'];";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
  });

  it('finds a shell call handed whole to the function that judges it in every reading', () => {
    const source = [
      "import { shellRoleCallOf } from '../permissions/service-role-call.ts';",
      "if (shell?.kind !== 'shell' || shell.command === undefined) return undefined;",
      'const call = await shellRoleCallOf(shell, context);',
    ].join('\n');
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
  });

  it('finds a read that weighs only the line as written', () => {
    const source = "const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: false });
  });

  it("finds a read of the port's shell call, weighed when it takes the call's readings", () => {
    const narrowed = "if (call?.kind !== 'shell' || call.command === undefined) return undefined;";
    assert.deepEqual(commandReadingOf('a.ts', `${narrowed}\nconst texts = call.readings;`), { readsCommand: true, importsReadings: true });
    assert.deepEqual(commandReadingOf('a.ts', `${narrowed}\nconst text = call.command;`), { readsCommand: true, importsReadings: false });
  });

  it('finds the shell call read by destructuring', () => {
    const source = "if (call.kind === 'shell') { const { command, readings: texts } = call; }";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
    assert.deepEqual(commandReadingOf('a.ts', "if (call.kind === 'shell') { const { command } = call; }"), { readsCommand: true, importsReadings: false });
  });

  it('finds the shell call narrowed in a switch', () => {
    const source = "switch (call.kind) { case 'shell': return call.command; default: return undefined; }";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: false });
  });

  it('finds the shell call read only by its readings, so a scan of the known guards never goes blind on one', () => {
    const source = "switch (call?.kind) { case 'shell': return call.readings.flatMap(found); default: return []; }";
    assert.deepEqual(commandReadingOf('a.ts', source), { readsCommand: true, importsReadings: true });
    assert.equal(commandReadingOf('a.ts', 'const texts = step.readings;').readsCommand, false);
  });

  it("finds a command read off the call's input as the host sent it, which takes no reading", () => {
    assert.deepEqual(commandReadingOf('a.ts', "const line = stringField(call.input, 'command');"), { readsCommand: true, importsReadings: false });
    assert.deepEqual(commandReadingOf('a.ts', "const { input } = call;\nconst line = input['command'];"), { readsCommand: true, importsReadings: false });
    assert.equal(commandReadingOf('a.ts', "const path = stringField(call.input, 'file_path');").readsCommand, false);
    assert.equal(commandReadingOf('a.ts', "const line = stringField(input, 'command');").readsCommand, false, 'a record of that name is no call');
  });

  it('leaves a command read off anything but a call narrowed to the shell kind', () => {
    assert.equal(commandReadingOf('a.ts', 'const line = step.command;').readsCommand, false);
    assert.equal(commandReadingOf('a.ts', "const name = 'shell';\nconst line = tool.command;").readsCommand, false);
    assert.equal(commandReadingOf('a.ts', "if (step.shape === 'shell') { run(step.command); }").readsCommand, false);
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
    assert.deepEqual(unweighed, [], "read the shell call's readings, hand the call to shellRouteOf or shellRoleCallOf, or add the file to EXEMPT with why its verdict cannot change");
  });

  it('keep no exemption for a file that no longer reads a command, or that weighs every reading now', () => {
    const stale = Object.keys(EXEMPT).filter((path) => readers.get(path) !== false);
    assert.deepEqual(stale, []);
  });
});
