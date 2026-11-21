import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasIssueOrReason, isIssueRef } from '../register/model.ts';
import { SRC_DIR, sourcesUnder, underSrc } from '../testing/source-files.ts';
import { bareRef, branchHint, parseRef, refOf } from './ref.ts';

describe('isIssueRef', () => {
  it('takes a ref by its prefix, and no other ref, no local reason and no missing one', () => {
    assert.equal(isIssueRef('gh:acme/web#7'), true);
    assert.equal(isIssueRef('gh:'), true);
    for (const ref of ['jira:ABC-1', 'local: an internal chore', 'GH:acme/web#7', ' gh:acme/web#7', 'acme/web#7', '', null, undefined]) {
      assert.equal(isIssueRef(ref), false, String(ref));
    }
  });

  it('is one of the two refs an add with an issue rule accepts', () => {
    assert.equal(hasIssueOrReason('gh:acme/web#7'), true);
    assert.equal(hasIssueOrReason('local: an internal chore'), true);
    assert.equal(hasIssueOrReason('T12'), false);
    assert.equal(hasIssueOrReason(null), false);
  });
});

describe('parseRef', () => {
  it('reads the repository, in lowercase, and the number', () => {
    assert.deepEqual(parseRef('gh:acme/web#7'), { repo: 'acme/web', number: 7 });
    assert.deepEqual(parseRef('gh:Acme/Web.site_2#612'), { repo: 'acme/web.site_2', number: 612 });
  });

  it('reads none from a ref of another kind, a missing one, or an issue ref that names no item', () => {
    for (const ref of ['acme/web#7', 'jira:ABC-1', 'local: an internal chore', 'gh:', 'gh:acme/web', 'gh:acme/web#0', 'gh:acme/web#7/comments', null, undefined]) {
      assert.equal(parseRef(ref), undefined, String(ref));
    }
  });
});

describe('refOf', () => {
  it('writes the ref parseRef reads back', () => {
    assert.equal(refOf({ repo: 'acme/web', number: 7 }), 'gh:acme/web#7');
    assert.deepEqual(parseRef(refOf({ repo: 'acme/web', number: 7 })), { repo: 'acme/web', number: 7 });
  });

  it('keeps the repository as given, since a sync keys its tasks by the ref it wrote', () => {
    assert.equal(refOf({ repo: 'Acme/Web', number: 7 }), 'gh:Acme/Web#7');
  });
});

describe('bareRef', () => {
  it('takes the prefix off a ref and leaves any other text as it is', () => {
    assert.equal(bareRef('gh:acme/web#7'), 'acme/web#7');
    assert.equal(bareRef('acme/web#7'), 'acme/web#7');
    assert.equal(bareRef('jira:ABC-1'), 'jira:ABC-1');
  });
});

describe('branchHint', () => {
  it("reads the number of a task's issue ref", () => {
    assert.equal(branchHint('gh:acme/app#933'), '933');
    assert.equal(branchHint(null), undefined);
    assert.equal(branchHint('jira:ABC-1'), undefined);
  });

  it('keeps the digits as written, and reads none from a ref with no number or with more after it', () => {
    assert.equal(branchHint('gh:acme/app#007'), '007');
    for (const ref of ['gh:acme/app', 'gh:acme/app#', 'gh:acme/app#12 x', 'gh:#12', 'gh:a#b#12', 'acme/app#12']) {
      assert.equal(branchHint(ref), undefined, ref);
    }
  });
});

/**
 * The prefix of an issue ref is named in two files of the core only, register/model.ts (what it is, and whether a ref
 * has it) and issues/ref.ts (everything past it), so a second tracker's refs change those two and no flow that holds
 * a ref. The GitHub adapter's declaration states it once more, as data: a declaration says what its tool's refs start
 * with, and the register cannot import an adapter to read it.
 */

/** The files that may name the prefix, as paths under `src` with `/`. */
const REF_MODULES = new Set(['register/model.ts', 'issues/ref.ts', 'adapters/connectors/github/declaration.ts']);
/** Text that starts as an issue ref does; `gh: ` with a space is the gh program's own error line, not a ref. */
const REF_TEXT = /^gh:(?!\s)/;
/** A pattern that matches an issue ref's prefix. */
const REF_PATTERN = /gh:/;

/** One place a source names the prefix, with its 1-based line. */
interface PrefixUse {
  readonly line: number;
  readonly text: string;
}

/** A string's text or a template's start; undefined for any other node. */
function literalStart(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return ts.isTemplateExpression(node) ? node.head.text : undefined;
}

/** What `node` names of the prefix: its constant, a string that starts with it, or a pattern that matches it. */
function prefixNamed(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text === 'ISSUE_REF_PREFIX' ? node.text : undefined;
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return REF_PATTERN.test(node.getText(file)) ? node.getText(file) : undefined;
  }
  const text = literalStart(node);
  return text !== undefined && REF_TEXT.test(text) ? text : undefined;
}

/** The places a source names the prefix; comments are no tokens, so an example ref in one is not a use. */
function prefixUses(fileName: string, source: string): PrefixUse[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: PrefixUse[] = [];
  const visit = (node: ts.Node): void => {
    const text = prefixNamed(node, file);
    if (text !== undefined) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('prefixUses', () => {
  it('finds the constant, a string or template that starts as a ref, and a pattern of one', () => {
    const source = [
      "import { ISSUE_REF_PREFIX } from '../register/model.ts';",
      "const isRef = ref.startsWith('gh:');",
      'const made = `gh:${repo}#${number}`;',
      'const number = /^gh:[^#]+#(\\d+)$/.exec(ref);',
    ].join('\n');
    assert.deepEqual(
      prefixUses('a.ts', source).map((use) => use.line),
      [1, 2, 3, 4],
    );
  });

  it("leaves a comment's example ref, the gh program's error line and a name that only holds the letters", () => {
    const source = [
      '/** Such as `gh:acme/app#933`; null for none. */',
      '// its ref gh:acme/web#7',
      "const stderr = 'gh: Not Found (HTTP 404)';",
      'const line = `gh: ${message}`;',
      "const word = 'high:tide';",
      'isIssueRef(task.ref);',
    ].join('\n');
    assert.deepEqual(prefixUses('a.ts', source), []);
  });
});

describe('teamrig code', () => {
  it('names the prefix of an issue ref only where refs are read and written (T4619)', () => {
    const files = sourcesUnder(SRC_DIR).filter((path) => !REF_MODULES.has(underSrc(path)));
    assert.ok(files.length > 100, `the scan read only ${files.length} files`);
    const found = files.flatMap((path) => prefixUses(path, readFileSync(path, 'utf8')).map((use) => `${underSrc(path)}:${use.line} ${JSON.stringify(use.text)}`));
    assert.deepEqual(found, []);
  });
});
