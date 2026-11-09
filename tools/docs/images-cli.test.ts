import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';
import { drawPictures, IMAGES_DIR } from './images.ts';

const CLI = fileURLToPath(new URL('./images-cli.ts', import.meta.url));
const HERO = `${IMAGES_DIR}/hero.svg`;
/** Every picture the CLI draws, in drawPictures' order (images.test.ts pins that order). */
const ALL = (await drawPictures()).map((picture) => `${IMAGES_DIR}/${picture.file}`);

describe('images-cli', () => {
  let repo: TempRepo;
  /** Runs the CLI on the temp repo from a folder outside it, so a write by the cwd would land in the wrong place. */
  const draw = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  beforeEach(() => {
    repo = new TempRepo('images');
  });
  afterEach(() => repo.remove());

  it('draws every picture into docs/images of the --root repo, not the cwd', () => {
    const result = draw();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ALL.map((path) => `images: wrote ${path}\n`).join(''));
    assert.match(readFileSync(join(repo.dir, HERO), 'utf8'), /^<svg xmlns=/);
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('--check passes on fresh pictures and changes nothing', () => {
    draw();
    const drawn = readFileSync(join(repo.dir, HERO), 'utf8');
    const result = draw(['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `images: ${ALL.length} picture(s) are up to date\n`);
    assert.equal(readFileSync(join(repo.dir, HERO), 'utf8'), drawn);
  });

  it('--check lists a missing or changed picture and exits 1 without redrawing it', () => {
    const missing = draw(['--check']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stdout, `images: stale; run \`npm run docs:images\` and commit the result:\n${ALL.map((path) => `  ${path}\n`).join('')}`);
    repo.write(HERO, '<svg/>\n');
    assert.equal(draw(['--check']).status, 1);
    assert.equal(readFileSync(join(repo.dir, HERO), 'utf8'), '<svg/>\n');
  });

  it('checks its own repo, not the cwd, when no --root is given, and writes nothing in the cwd', () => {
    const foreign = repo.runOutside(CLI, ['--check']);
    assert.equal(foreign.stderr, '');
    assert.deepEqual(foreign, repo.runOutside(CLI, ['--check', '--root', TOOLS_REPO]));
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('exits 2 on an unknown option', () => {
    const result = draw(['--fix']);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'images: unknown option --fix (usage: images-cli.ts [--check] [--root <repo>])\n');
  });
});
