import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { treeOf, wholeNumberTriples, type ProcessLink } from './processes.ts';

/** A host of processes: 1 starts 10, 10 starts 11 and 12, 12 starts 13; 20 is apart. */
const LINKS: readonly ProcessLink[] = [
  { pid: 1, parent: 0 },
  { pid: 10, parent: 1 },
  { pid: 11, parent: 10 },
  { pid: 12, parent: 10 },
  { pid: 13, parent: 12 },
  { pid: 20, parent: 1 },
];

describe('treeOf', () => {
  it('lists a process and every descendant, leaving out processes beside it', () => {
    assert.deepEqual(
      treeOf(10, LINKS).map((row) => row.pid),
      [10, 11, 12, 13],
    );
  });

  it('keeps the rows as listed, with every field they carry', () => {
    const rows = [
      { pid: 3, parent: 1, startedMs: 100 },
      { pid: 4, parent: 3, startedMs: 200 },
    ];
    assert.deepEqual(treeOf(3, rows), rows);
  });

  it('is empty for a process that is not listed', () => {
    assert.deepEqual(treeOf(99, LINKS), []);
  });

  it('stops at a parent loop or a process that names itself as its parent', () => {
    const looped: ProcessLink[] = [
      { pid: 5, parent: 5 },
      { pid: 6, parent: 7 },
      { pid: 7, parent: 6 },
    ];
    assert.deepEqual(
      treeOf(5, looped).map((row) => row.pid),
      [5],
    );
    assert.deepEqual(
      treeOf(6, looped).map((row) => row.pid),
      [6, 7],
    );
  });
});

describe('wholeNumberTriples', () => {
  it('reads PowerShell commas and ps columns, leaving out headers, damaged lines and other widths', () => {
    assert.deepEqual(wholeNumberTriples('4,0,1024\r\n  77   4  2048\nProcessId,ParentProcessId\n9,x,1\n1,2\n1,2,3,4\n2.5,1,1\n\n'), [
      [4, 0, 1024],
      [77, 4, 2048],
    ]);
  });
});
