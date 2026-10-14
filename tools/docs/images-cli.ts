import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { runMain } from '../lib/run-main.ts';
import { drawPictures, stalePictures, writePictures } from './images.ts';

/** Draws the README's pictures into docs/images; `--check` only reports the ones that are missing or stale. */
async function main(args: readonly string[]): Promise<number> {
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')} (usage: images-cli.ts [--check])`);
  const pictures = await drawPictures();
  const root = process.cwd();
  if (!args.includes('--check')) {
    writePictures(root, pictures).forEach((path) => console.log(`images: wrote ${path}`));
    return EXIT_CLEAN;
  }
  const stale = stalePictures(root, pictures);
  if (stale.length === 0) {
    console.log(`images: ${pictures.length} picture(s) match the CLI's output`);
    return EXIT_CLEAN;
  }
  console.log('images: stale; run `npm run docs:images` and commit the result:');
  stale.forEach((path) => console.log(`  ${path}`));
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('images', () => main(process.argv.slice(2)), (line) => console.error(line));
