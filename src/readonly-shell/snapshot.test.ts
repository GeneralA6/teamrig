import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { newestSnapshotExports, NO_SNAPSHOT, snapshotExportsIn } from './snapshot.ts';

/** The layout Claude Code writes: aliases off, options, wrapper functions, then the exported PATH. */
const SNAPSHOT = [
  '# Snapshot file',
  'unalias -a 2>/dev/null || true',
  'shopt -s expand_aliases',
  'if ! hash rg 2>/dev/null && ! typeset -f rg >/dev/null 2>&1; then',
  '  function rg {',
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
  '  local -a _cc_probe=()',
  '}',
  'fi',
  "export PATH='/c/Users/u/bin:/mingw64/bin:/c/Program Files/Git/cmd'",
].join('\n');

const names = (text: string) => [...snapshotExportsIn(text).names].sort();

describe('snapshotExportsIn', () => {
  it("reads the names Claude Code's snapshot exports, and no set -a", () => {
    assert.deepEqual(snapshotExportsIn(SNAPSHOT), { names: new Set(['PATH']), all: false });
  });

  it('reads export, declare -x, typeset -gx and local -x, several names to a line and one in a function body', () => {
    const text = 'declare -x LESSOPEN="|x %s"\ntypeset -gx A_B\nexport -n C D=1 E=2\nf() { export F=1; local -x G; }';
    assert.deepEqual(names(text), ['A_B', 'C', 'D', 'E', 'F', 'G', 'LESSOPEN']);
  });

  it('reads a quoted name and past a quoted separator, and stops at a real one', () => {
    assert.deepEqual(names(`export A="x|y; z" B=1 'C'=2; echo D=1`), ['A', 'B', 'C']);
    assert.deepEqual(names("export H='it\"s' I"), ['H', 'I']);
  });

  it('reads no name from a declaration that does not export', () => {
    assert.deepEqual(names('declare -f rg\ntypeset -a list=()\nlocal _cc_a\nreadonly R=1\necho export'), []);
  });

  it('reads set -a and set -o allexport in any form, and no other option', () => {
    for (const text of ['set -a', 'set -ea', 'set -o allexport', 'f() { set +o allexport; }', 'true; set -a']) {
      assert.equal(snapshotExportsIn(text).all, true, text);
    }
    for (const text of ['set -euo pipefail', 'set -e', 'set -- a b', 'set -o vi', 'reset -a']) {
      assert.equal(snapshotExportsIn(text).all, false, text);
    }
  });
});

describe('newestSnapshotExports', () => {
  const dir = join('/', 'u', '.claude', 'shell-snapshots');

  it('reads the snapshot made last, by its time and not its name, skipping other files', async () => {
    const files = new MemoryFiles({
      [join(dir, 'snapshot-bash-999-old.sh')]: 'export OLD=1',
      [join(dir, 'snapshot-bash-1000-new.sh')]: 'export NEW=1',
      [join(dir, 'snapshot-bash-x-bad.sh')]: 'export BAD=1',
      [join(dir, 'notes.txt')]: 'export NOTE=1',
    });
    assert.deepEqual(await newestSnapshotExports(files, dir), { names: new Set(['NEW']), all: false });
  });

  it('reads nothing when there is no snapshot', async () => {
    assert.deepEqual(await newestSnapshotExports(new MemoryFiles(), dir), NO_SNAPSHOT);
  });
});
