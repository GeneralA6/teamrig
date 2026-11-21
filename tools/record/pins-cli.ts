import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { expectedFolder, recordedPins } from '../../src/testing/recorded-pins.ts';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { runMain } from '../lib/run-main.ts';

/** Where the pins live, from the repository's root: the folder the pinning suite reads, as the recorder names its own. */
const DEFAULT_OUT = relative(fileURLToPath(new URL('../../', import.meta.url)), expectedFolder('claude-code'));
/** The pinned folder a new run replaces whole, so no file of an event that is no longer recorded stays. */
const REPLACED = 'hooks';

/**
 * `node tools/record/pins-cli.ts [--out <folder>]`, run from the repository's root, writes what teamrig does today
 * with the recorded Claude Code session (src/testing/recorded-pins.ts) to the recording's `expected/` folder, or to
 * `<folder>`. Run it after a change that is meant to alter what a hook prints, read the diff, and commit it with the
 * change: the pinning suite fails until the committed files say what the code does.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: DEFAULT_OUT } }, strict: true, allowPositionals: false });
  const out = resolve(values.out);
  const files = await recordedPins('claude-code');
  rmSync(join(out, REPLACED), { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  console.log(`pins: ${Object.keys(files).length} file(s) written to ${out}`);
  return EXIT_CLEAN;
}

process.exitCode = await runMain('pins', main, (line) => console.error(line));
