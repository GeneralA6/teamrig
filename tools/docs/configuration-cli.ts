import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { CONFIG_DOC, loadConfigSchema, renderConfigReference } from './configuration.ts';

/**
 * Draws docs/configuration.md of this repo (or `--root <repo>`) from the config schema; `--check` only reports
 * whether the page is missing or stale.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root, rest } = takeRoot(args);
  const unknown = rest.filter((arg) => arg !== '--check');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')} (usage: configuration-cli.ts [--check] [--root <repo>])`);
  const page = renderConfigReference(loadConfigSchema());
  const target = join(root, CONFIG_DOC);
  if (!rest.includes('--check')) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, page);
    console.log(`config: wrote ${CONFIG_DOC}`);
    return EXIT_CLEAN;
  }
  if (existsSync(target) && readFileSync(target, 'utf8') === page) {
    console.log(`config: ${CONFIG_DOC} is up to date`);
    return EXIT_CLEAN;
  }
  console.log('config: stale; run `npm run docs:config` and commit the result');
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('config', () => main(process.argv.slice(2)), (line) => console.error(line));
