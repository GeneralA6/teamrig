import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { SRC_DIR, sourcesUnder, underSrc } from '../testing/source-files.ts';
import * as kit from './index.ts';

const KIT_DIR = join(SRC_DIR, 'conformance');

/** What a file of the kit may import from outside its folder. */
const ALLOWED = new Set(['node:assert/strict', 'plugin-api/index.ts']);

/** Every module a source names in an import or a re-export. */
function importsOf(path: string): readonly string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    const named = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
    return named !== undefined && ts.isStringLiteral(named) ? [named.text] : [];
  });
}

/** An import as the rule names it: a module of Node by its name, a file of teamrig by its path under `src`. */
function targetOf(path: string, name: string): string {
  return name.startsWith('.') ? underSrc(join(path, '..', name)) : name;
}

describe('the conformance kit', () => {
  it('exports what a contract and a binding are written with, and nothing leaves or joins it unseen', () => {
    assert.deepEqual(Object.keys(kit).sort(), ['CONTRACTS', 'PERMISSIONS_CONTRACT', 'PLUGIN_CONTRACT', 'STATUS_LINE_CONTRACT', 'TERMINAL_CONTRACT', 'TRANSCRIPT_CONTRACT', 'USAGE_CONTRACT', 'bind', 'choiceOf', 'defineContract', 'entryOf', 'kitProblems', 'nothingPermissions', 'nothingPlugin', 'nothingStatusLine', 'nothingTerminal', 'nothingTranscripts', 'nothingUsage', 'osOf', 'referenceTerminal', 'runCases', 'yesPermissions', 'yesPlugin', 'yesStatusLine', 'yesTerminal', 'yesTranscripts', 'yesUsage']);
  });

  it('imports the plugin API, node:assert and its own folder, nothing else, so it ships to an outside host as it is', () => {
    const files = sourcesUnder(KIT_DIR);
    assert.ok(files.length >= 4, `the scan read only ${files.length} files`);
    const strays = files.flatMap((path) =>
      importsOf(path)
        .map((name) => targetOf(path, name))
        .filter((target) => !target.startsWith('conformance/') && !ALLOWED.has(target))
        .map((target) => `${underSrc(path)} imports ${target}`),
    );
    assert.deepEqual(strays, []);
  });

  it('reads an import and a re-export alike, by the file it names', () => {
    const index = join(KIT_DIR, 'index.ts');
    assert.deepEqual([...new Set(importsOf(index).map((name) => targetOf(index, name)))].sort(), ['conformance/choice.ts', 'conformance/contract.ts', 'conformance/host/permissions.ts', 'conformance/host/plugin.ts', 'conformance/host/status-line.ts', 'conformance/host/transcript.ts', 'conformance/host/usage.ts', 'conformance/kit.ts', 'conformance/terminal/reference.ts', 'conformance/terminal/terminal.ts']);
    assert.equal(targetOf(index, '../plugin-api/index.ts'), 'plugin-api/index.ts');
    assert.equal(targetOf(index, 'node:fs'), 'node:fs');
  });

  it('holds every contract it lists to its liars and to the naming of its cases', async () => {
    assert.deepEqual(await kit.kitProblems(kit.CONTRACTS), []);
  });
});
