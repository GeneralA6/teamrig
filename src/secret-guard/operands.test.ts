import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { programsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { fileOperands } from './operands.ts';

/** The words of the line's first program that may name a file it prints. */
function operands(line: string, dialect: ShellDialect = 'bash'): string[] {
  const [run] = programsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect });
  return run === undefined ? [] : fileOperands(run.name, run.args).map((word) => word.text);
}

describe('fileOperands', () => {
  it('leaves out the script or pattern a printer takes first, past the options and their values', () => {
    const rows: readonly (readonly [line: string, expected: readonly string[]])[] = [
      ["sed -n 's/x/y/p' a.txt", ['-n', 'a.txt']],
      ['grep -rn TOKEN src', ['-rn', 'src']],
      ['grep -A 3 x a.txt', ['-A', '3', 'a.txt']],
      ['grep -A3 x a.txt', ['-A3', 'a.txt']],
      ['grep --max-count 2 x a.txt', ['--max-count', '2', 'a.txt']],
      ['grep -- -x a.txt', ['--', 'a.txt']],
      ["rg -i -g '*.ts' pattern src", ['-i', '-g', '*.ts', 'src']],
      ['sed -i.bak s/a/b/ a.txt', ['-i.bak', 'a.txt']],
      ["awk -F: -v n=1 '{print $1}' a.txt", ['-F:', '-v', 'n=1', 'a.txt']],
      ["jq --arg k v -r '.a' a.json", ['--arg', 'k', 'v', '-r', 'a.json']],
      ['findstr /r x a.txt', ['/r', 'a.txt']],
      ['cat a.txt b.txt', ['a.txt', 'b.txt']],
    ];
    for (const [line, expected] of rows) {
      assert.deepEqual(operands(line), expected, line);
    }
  });

  it('keeps every operand when an option gives the script or pattern, wherever it stands', () => {
    for (const line of [
      'grep -e x a.txt',
      'grep x a.txt -e y',
      'grep -ie x a.txt',
      'grep -ex a.txt',
      'grep --reg=x a.txt',
      'rg -f p.txt a.txt',
      'sed -f s.sed a.txt',
      'sed --expression=s/a/b/ a.txt',
      'awk -f p.awk a.txt',
      "gawk -e '{print}' a.txt",
      'jq -f f.jq a.json',
      'findstr /C:x a.txt',
    ]) {
      const [run] = programsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' });
      assert.deepEqual(operands(line), run?.args.map((word) => word.text), line);
    }
  });

  it("reads Select-String's pattern by position or by name, in any case", () => {
    assert.deepEqual(operands("Select-String '.*' a.txt", 'powershell'), ['a.txt']);
    assert.deepEqual(operands('sls x -Path a.txt', 'powershell'), ['-Path', 'a.txt']);
    assert.deepEqual(operands('Select-String -pattern x a.txt', 'powershell'), ['-pattern', 'x', 'a.txt']);
    assert.deepEqual(operands('Select-String -Pattern:x a.txt', 'powershell'), ['-Pattern:x', 'a.txt']);
  });

  it('names no file for a program that reads only stdin', () => {
    assert.deepEqual(operands("tr -d '.*'"), []);
  });
});
