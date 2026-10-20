import { recordAt, recordOf, stringAt } from './json.ts';

/**
 * The dist rebuild a ship runs: the repo's own `scripts.build`, step by step, so the committed dist is the one the
 * local gate's build makes (T755: a hard-coded copy lacked the new integrity step, and dist-fresh refused the ship).
 */

/** The node arguments of one build step: a script with its arguments, or TypeScript's compiler with its own. */
export type BuildStep = readonly string[];

/** The build script of a package.json's text. */
export function buildScriptOf(packageJson: string): string {
  return stringAt(recordAt(recordOf(packageJson, 'package.json'), 'scripts', 'package.json'), 'build', 'package.json scripts');
}

/**
 * The steps of a build script: a `&&` chain of `node <script> ...` and `tsc ...` commands with plain words, run
 * here with node and no shell. Any other program, a quote or a shell operator is refused, never guessed.
 */
export function buildSteps(script: string): readonly BuildStep[] {
  return script.split('&&').map((part) => {
    const words = part.trim().split(/\s+/u);
    const [program = '', ...args] = words;
    const plain = args.every((word) => /^[\w./:@=-]+$/u.test(word));
    if (program === 'node' && args.length > 0 && plain) return args;
    if (program === 'tsc' && plain) return ['node_modules/typescript/bin/tsc', ...args];
    throw new Error(`REFUSED the build step "${part.trim()}": a ship runs only plain node and tsc steps of scripts.build`);
  });
}
