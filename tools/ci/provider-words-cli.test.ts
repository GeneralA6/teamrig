import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';
import { baselineText, parseBaseline } from './provider-words.ts';

const CLI = fileURLToPath(new URL('./provider-words-cli.ts', import.meta.url));
const BASELINE = 'tools/ci/provider-words.json';
const PLUGIN = 'plugins/teamrig/skills/write-issue';
const OWN = '.claude/skills/dev-ship';
const total = (words: number, skills: number, clear: number): string => `provider-words: ${words} host or tool words in ${skills} skills, ${clear} with none; a count may fall, never rise\n`;

describe('provider-words-cli', () => {
  let repo: TempRepo;
  const check = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  const baseline = (entries: readonly (readonly [string, number])[]): void => {
    repo.write(BASELINE, baselineText(new Map(entries)));
  };
  const written = (): ReadonlyMap<string, number> => parseBaseline(JSON.parse(readFileSync(join(repo.dir, BASELINE), 'utf8')));
  /** Two skills: the plugin's with 2 words over two files, this repo's own with 1, plus files the check must skip. */
  const skills = (): void => {
    repo.write(`${PLUGIN}/SKILL.md`, 'Open a pull request.\n');
    repo.write(`${PLUGIN}/more/notes.md`, 'On GitHub.\n');
    repo.write(`${PLUGIN}/steps.md`, 'gh pr create, GitHub, Jira\n');
    repo.write(`${PLUGIN}/script.ts`, 'gh\n');
    repo.write(`${OWN}/SKILL.md`, 'Run /clear, then a high five.\n');
    repo.write('plugins/teamrig/skills/README.md', 'GitHub\n');
    repo.write('docs/guide.md', 'GitHub\n');
  };
  beforeEach(() => {
    repo = new TempRepo('provider-words');
  });
  afterEach(() => repo.remove());

  it("passes counts at their baseline, reading every skill's Markdown but its step texts", () => {
    skills();
    baseline([[OWN, 1], [PLUGIN, 2]]);
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, total(3, 2, 0));
  });

  it('fails a count above its baseline, and any word in a skill the baseline lacks', () => {
    skills();
    baseline([[PLUGIN, 1]]);
    const result = check();
    assert.equal(result.status, 1, result.stderr);
    const rose = [`provider-words: ${OWN} rose to 1 from 0`, `provider-words: ${PLUGIN} rose to 2 from 1`].map((line) => `${line}: say the step and let the adapter say how\n`);
    assert.equal(result.stdout, `${rose.join('')}${total(3, 2, 0)}`);
  });

  it('passes a fall and a gone skill, naming --write for each', () => {
    skills();
    baseline([[OWN, 4], [PLUGIN, 2], ['.claude/skills/old', 3]]);
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `provider-words: ${OWN} fell to 1 from 4: run --write to lower its baseline\nprovider-words: .claude/skills/old is gone: run --write to drop its baseline\n${total(3, 2, 0)}`);
  });

  it('--list prints each hit before the counts, the plugin skills first', () => {
    skills();
    baseline([[OWN, 1], [PLUGIN, 2]]);
    const result = check(['--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${PLUGIN}/SKILL.md:1: pull request\n${PLUGIN}/more/notes.md:1: GitHub\n${OWN}/SKILL.md:1: /clear\n${total(3, 2, 0)}`);
  });

  it('--write records falls, new skills and drops gone ones', () => {
    skills();
    repo.write('.claude/skills/clean/SKILL.md', 'Nothing of one product.\n');
    baseline([[PLUGIN, 5], ['.claude/skills/old', 3]]);
    const result = check(['--write']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `provider-words: ${OWN} rose to 1 from 0: say the step and let the adapter say how\nprovider-words: wrote ${BASELINE}\n`);
    assert.deepEqual([...written()], [['.claude/skills/clean', 0], [OWN, 1], [PLUGIN, 2]]);
  });

  it('--write refuses a rise over a recorded baseline and writes nothing', () => {
    skills();
    baseline([[OWN, 1], [PLUGIN, 1]]);
    const result = check(['--write']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /wrote nothing: a count never rises\n$/);
    assert.deepEqual([...written()], [[OWN, 1], [PLUGIN, 1]]);
  });

  it('counts nothing in a repo with no skills and no baseline', () => {
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, total(0, 0, 0));
  });

  it('exits 2 on an unknown option or a broken baseline', () => {
    const unknown = check(['--fix']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'provider-words: unknown option --fix (usage: provider-words-cli.ts [--list] [--write] [--root <repo>])\n');
    repo.write(BASELINE, '{"skills": {"a": "x"}}');
    const broken = check();
    assert.equal(broken.status, 2);
    assert.equal(broken.stderr, 'provider-words: the baseline count of a is not a whole number\n');
  });

  it('checks its own repo, which its baseline holds, when no --root is given, and writes nothing in the cwd', () => {
    const own = repo.runOutside(CLI);
    assert.equal(own.stderr, '');
    assert.equal(own.status, 0, own.stdout);
    assert.deepEqual(own, repo.runOutside(CLI, ['--root', TOOLS_REPO]));
    assert.deepEqual(readdirSync(repo.outside), []);
  });
});
