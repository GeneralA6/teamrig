import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readDeclarations } from '../../src/composition/loader.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { PARITY_DOC, renderParity } from './parity.ts';

/**
 * Draws docs/parity.md of this repo (or `--root <repo>`) from the declarations of the adapters this checkout ships;
 * `--check` only reports whether the page is missing or stale.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root, rest } = takeRoot(args);
  const unknown = rest.filter((arg) => arg !== '--check');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')} (usage: parity-cli.ts [--check] [--root <repo>])`);
  const page = renderParity(await readDeclarations());
  const target = join(root, PARITY_DOC);
  if (!rest.includes('--check')) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, page);
    console.log(`parity: wrote ${PARITY_DOC}`);
    return EXIT_CLEAN;
  }
  if (existsSync(target) && readFileSync(target, 'utf8') === page) {
    console.log(`parity: ${PARITY_DOC} is up to date`);
    return EXIT_CLEAN;
  }
  console.log('parity: stale; run `npm run docs:parity` and commit the result');
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('parity', () => main(process.argv.slice(2)), (line) => console.error(line));
