import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs, describeProblems, headingAnchors, tableCells, type DocFile } from './doc-check.ts';

const FILES = new Set(['README.md', 'LICENSE', 'docs/how-it-works.md', 'docs/images/hero.svg', 'docs/a b.md']);
const exists = (path: string): boolean => FILES.has(path);
const check = (...docs: DocFile[]): string[] => describeProblems(checkDocs(docs, exists).problems);
const readme = (text: string): DocFile => ({ path: 'README.md', text });

describe('headingAnchors', () => {
  it('slugs headings the way GitHub does', () => {
    const anchors = headingAnchors('# teamrig\n## Quick start\n### `teamrig` in 5 minutes!\n## Works with: [Codex](x.md)\n## Ünïcode & co\n');
    assert.deepEqual([...anchors], ['teamrig', 'quick-start', 'teamrig-in-5-minutes', 'works-with-codex', 'ünïcode--co']);
  });

  it('numbers a repeated heading and ignores headings inside code', () => {
    const anchors = headingAnchors('## Setup\n```sh\n# not a heading\n```\n## Setup\n## Setup ##\n');
    assert.deepEqual([...anchors], ['setup', 'setup-1', 'setup-2']);
  });
});

describe('tableCells', () => {
  it('splits at every pipe with no backslash before it, in a code span too, as GitHub does (#1828)', () => {
    assert.equal(tableCells('| a | b | c |'), 3);
    assert.equal(tableCells('a | b | c'), 3);
    assert.equal(tableCells('  | a | b  '), 2);
    assert.equal(tableCells('| `x \\| y` | z |'), 2);
    assert.equal(tableCells('| `x | y` | z |'), 3);
    assert.equal(tableCells('| `\\\\|` | b |'), 2, 'a backslash before a pipe escapes it, even an escaped one');
    assert.equal(tableCells('| ünï | çödé |'), 2);
    assert.equal(tableCells('|'), 1, 'one empty cell');
  });
});

describe('checkDocs', () => {
  it('passes links, images and anchors that resolve, and counts them', () => {
    const report = checkDocs(
      [
        readme('# teamrig\n<img src="docs/images/hero.svg" alt="x">\n[how](docs/how-it-works.md#the-parts) and [up](#teamrig) [l][lic]\n\n[lic]: LICENSE\n'),
        { path: 'docs/how-it-works.md', text: '## The parts\n![hero](images/hero.svg "Hero") [back](../README.md#teamrig) [sp](a%20b.md) [ext](https://example.com) [mail](mailto:a@example.com)\n' },
      ],
      exists,
    );
    assert.deepEqual(report.problems, []);
    assert.equal(report.links, 7);
  });

  it('reports a missing file, a missing anchor and a link out of the repo, with the line', () => {
    const problems = check(
      readme('# teamrig\n\n[a](docs/missing.md) [b](#nowhere)\n[c](docs/how-it-works.md#gone) [d](../other/README.md)\n'),
      { path: 'docs/how-it-works.md', text: '## The parts\n' },
    );
    assert.deepEqual(problems, [
      'README.md:3 docs/missing.md: no file docs/missing.md',
      'README.md:3 #nowhere: no heading #nowhere in README.md',
      'README.md:4 docs/how-it-works.md#gone: no heading #gone in docs/how-it-works.md',
      'README.md:4 ../other/README.md points outside the repo',
    ]);
  });

  it('checks only that a file exists when the anchor is in a doc it was not given', () => {
    assert.deepEqual(check(readme('[l](LICENSE#section) [x](nope.md#a)\n')), ['README.md:1 nope.md#a: no file nope.md']);
  });

  it('reports a link it cannot decode', () => {
    assert.deepEqual(check(readme('[a](bad%E0.md)\n')), ['README.md:1 bad%E0.md: not a valid link']);
  });

  it('resolves a link starting with / from the repo root, as GitHub does', () => {
    const doc: DocFile = { path: 'docs/how-it-works.md', text: '[a](/README.md#teamrig) [b](/docs/images/hero.svg) [c](/etc/passwd)\n' };
    assert.deepEqual(check(readme('# teamrig\n'), doc), ['docs/how-it-works.md:1 /etc/passwd: no file etc/passwd']);
  });

  it('finds the inner and the outer target of a badge link', () => {
    assert.deepEqual(check(readme('[![CI](docs/images/ci.svg)](docs/ci.md)\n')), [
      'README.md:1 docs/images/ci.svg: no file docs/images/ci.svg',
      'README.md:1 docs/ci.md: no file docs/ci.md',
    ]);
  });

  it('ignores links inside code blocks and inline code', () => {
    assert.deepEqual(check(readme('Run `[x](missing.md)`.\n```md\n[y](missing.md)\n```\n~~~\n[z](missing.md)\n~~~\n')), []);
  });

  it('accepts the Mermaid diagram types GitHub draws, after comments and blank lines', () => {
    const report = checkDocs([readme('```mermaid\n%% the parts\n\nflowchart LR\n  a --> b\n```\n```mermaid\nsequenceDiagram\n```\n```mermaid\nstateDiagram-v2\n```\n')], exists);
    assert.deepEqual(report.problems, []);
    assert.equal(report.diagrams, 3);
  });

  it('reports an empty or unknown Mermaid block and a block never closed', () => {
    assert.deepEqual(check(readme('```mermaid\n\n```\n```mermaid\nflowchartLR\n```\n````mermaid\ngraph TD\n```\n')), [
      'README.md:1 an empty mermaid block',
      'README.md:4 a mermaid block opens with "flowchartLR", not one of: flowchart, graph, sequenceDiagram, stateDiagram-v2, stateDiagram, classDiagram, erDiagram, timeline, mindmap',
      'README.md:7 a mermaid block is never closed',
    ]);
  });

  it('passes tables whose rows match their header, and counts them (#1828)', () => {
    const report = checkDocs([readme('| a | b |\n|:--|--:|\n| `x \\| y` | 2 |\n| 3 | |\n\ntext | with | pipes\n\na | b\n- | -\n1 | 2\n')], exists);
    assert.deepEqual(report.problems, []);
    assert.equal(report.tables, 2);
  });

  it('reports a row with a cell count other than its header, with its line, until the table ends', () => {
    assert.deepEqual(check(readme('# x\n| a | b | c |\n|---|---|---|\n| `meet | x` | y | z |\n| ok | ok | ok |\n| short | row |\nno pipe\n\n| after | the | blank |\n## h\n')), [
      'README.md:4 a table row has 4 cell(s), its header 3: an unescaped | splits a cell (write \\| inside code too)',
      'README.md:6 a table row has 2 cell(s), its header 3: an unescaped | splits a cell (write \\| inside code too)',
      'README.md:7 a table row has 1 cell(s), its header 3: an unescaped | splits a cell (write \\| inside code too)',
    ]);
  });

  it('reports a header whose delimiter row has another cell count, and ignores pipes in fenced code', () => {
    assert.deepEqual(check(readme('| a | b |\n|---|---|---|\n| 1 | 2 |\n```\n| a | b |\n|---|\n| 1 | 2 | 3 |\n```\n')), [
      'README.md:1 a table header has 2 cell(s) but its delimiter row 3, so GitHub draws no table',
    ]);
  });

  it('ends a table at a line that starts another block, and reads no table in an HTML comment or indented code', () => {
    const ended = '| a | b |\n|---|---|\n| 1 | 2 |\n> a quote | here\n- a list | item | more\n'
      + '\n| a | b |\n|---|---|\n1. ordered | x | y\n\n| a | b |\n|---|---|\n<details><summary>x</summary>\n\n| a | b |\n|---|---|\n***\n';
    assert.deepEqual(check(readme(ended)), []);
    const hidden = '<!--\n| a | b |\n|---|---|\n| 1 | 2 | 3 |\n-->\n<!-- one | line | -->\n\n    | a | b |\n    |---|---|\n    | 1 | 2 | 3 |\n';
    assert.deepEqual(check(readme(hidden)), []);
    assert.deepEqual(check(readme('<!-- c -->\n| a | b |\n|---|---|\n| 1 | 2 | 3 |\nplain | row\n')), [
      'README.md:4 a table row has 3 cell(s), its header 2: an unescaped | splits a cell (write \\| inside code too)',
    ], 'a table after a closed comment, its plain row still in it');
  });

  it('names a plain code block that is never closed', () => {
    assert.deepEqual(check(readme('# x\n```\nnpm ci\n')), ['README.md:2 a code block is never closed']);
  });
});
