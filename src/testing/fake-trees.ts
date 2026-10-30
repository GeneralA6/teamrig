import { join } from 'node:path';
import type { CheckedTree, CleanTree, TreeState } from '../delivery/push-pass.ts';

/** The git folder of {@link cleanTree}'s repository, where its passes are kept. */
export const GIT_DIR = join('/', 'work', 'app', '.git');

/** A clean working tree whose HEAD has the tree id `tree`. */
export function cleanTree(tree: string = 'a1b2c3d4', commit: string = 'c0ffee12345'): CleanTree {
  return { kind: 'clean', tree, commit, gitDir: GIT_DIR };
}

/** A working tree a test sets and changes: every look reads `state` (default no repository) and records its folder. */
export class FakeTrees implements TreeState {
  readonly looks: string[] = [];
  state: CheckedTree;

  constructor(state: CheckedTree = { kind: 'none' }) {
    this.state = state;
  }

  checked(dir: string): CheckedTree {
    this.looks.push(dir);
    return this.state;
  }
}
