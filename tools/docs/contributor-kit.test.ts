import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMMITS } from '../../src/config/defaults.ts';
import { descriptionOf } from '../../src/skills/lint.ts';
import { checkDocs, type DocFile } from './doc-check.ts';

/**
 * The contributor kit, held to the repo so none of it can drift: the root CLAUDE.md (the rules on every turn), the
 * project skills in .claude/skills (the steps of each repeated job) and CONTRIBUTING.md (the methodology both point
 * to). Each skill is named after its folder, with a short plain description and a verified date; CLAUDE.md and
 * CONTRIBUTING name every skill; each repo path the kit quotes exists; its links resolve; and its commit size limits
 * are the ones teamrig applies to a team's pushes.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = '.claude/skills';
const MAX_DESCRIPTION_WORDS = 30;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
const frontmatterOf = (text: string): string => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';

const folders = readdirSync(join(ROOT, SKILLS), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const skills: readonly DocFile[] = folders.map((folder) => ({ path: `${SKILLS}/${folder}/SKILL.md`, text: read(`${SKILLS}/${folder}/SKILL.md`) }));
const rules: DocFile = { path: 'CLAUDE.md', text: read('CLAUDE.md') };
const contributing: DocFile = { path: 'CONTRIBUTING.md', text: read('CONTRIBUTING.md') };
const kit: readonly DocFile[] = [rules, contributing, ...skills];

/** A repo path quoted in backticks, such as `src/cli/run.ts`; a pattern with a placeholder (`<name>`, `*`) is not one. */
const REPO_PATH = /`((?:src|tools|plugins|docs|\.github|\.githooks|\.claude)\/[^`]*)`/g;
const quotedPaths = (doc: DocFile): string[] =>
  [...doc.text.matchAll(REPO_PATH)].map((match) => match[1] ?? '').filter((path) => !/[<>*\s]/.test(path));

describe('the contributor kit', () => {
  it('reads the project skills from .claude/skills', () => {
    assert.deepEqual(folders, ['dev-add-command', 'dev-add-config-key', 'dev-ship-change', 'dev-update-docs']);
  });

  for (const skill of skills) {
    describe(skill.path, () => {
      const front = frontmatterOf(skill.text);

      it('is named after its folder', () => {
        assert.equal(/^name:\s*(\S+)\s*$/m.exec(front)?.[1], skill.path.split('/').at(-2));
      });

      it(`has a description of at most ${MAX_DESCRIPTION_WORDS} words, a plain YAML value with no ": " in it`, () => {
        const description = descriptionOf(front);
        assert.ok(description !== null, `${skill.path} has a description`);
        assert.ok(description.split(/\s+/).length <= MAX_DESCRIPTION_WORDS, description);
        assert.doesNotMatch(description, /:\s/);
      });

      it('grants no tools, and says when its steps last held', () => {
        assert.doesNotMatch(front, /^allowed-tools\s*:/m);
        assert.match(skill.text, /^Last verified: \d{4}-\d{2}-\d{2}$/m);
      });
    });
  }

  it('names every project skill in CLAUDE.md and CONTRIBUTING.md', () => {
    for (const doc of [rules, contributing]) {
      assert.deepEqual(folders.filter((folder) => !doc.text.includes(`\`${folder}\``)), [], doc.path);
    }
  });

  it('quotes only repo paths that exist, and skips a pattern with a placeholder', () => {
    assert.deepEqual(quotedPaths({ path: 'x.md', text: '`src/cli/run.ts`, `src/<name>.test.ts`, `docs/*.md`' }), ['src/cli/run.ts']);
    const missing = kit.flatMap((doc) => quotedPaths(doc).filter((path) => !existsSync(join(ROOT, path))).map((path) => `${doc.path}: ${path}`));
    assert.deepEqual(missing, []);
  });

  it('has relative links and anchors that resolve', () => {
    const report = checkDocs(kit, (target) => existsSync(join(ROOT, target)));
    assert.deepEqual(report.problems, []);
  });

  it("gives the commit size limits teamrig applies to a team's pushes", () => {
    const limit = `${DEFAULT_COMMITS.maxLines} changed non-test lines or ${DEFAULT_COMMITS.maxFiles} non-test`;
    const trailer = `\`${DEFAULT_COMMITS.largeCommitTrailer}: <reason>\``;
    for (const doc of [rules, contributing, ...skills.filter((skill) => skill.path.includes('dev-ship-change'))]) {
      assert.ok(doc.text.replace(/\s+/g, ' ').includes(limit), `${doc.path} names ${limit}`);
      assert.ok(doc.text.includes(trailer), `${doc.path} names ${trailer}`);
    }
  });
});
