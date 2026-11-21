import { join } from 'node:path';
import type { CheckedTree, CleanTree, TreeState } from '../delivery/push-pass.ts';
import type { RunTree } from '../delivery/run-tree.ts';

/** The git folder of {@link cleanTree}'s repository, where its passes are kept. */
export const GIT_DIR = join('/', 'work', 'app', '.git');

/** A clean working tree whose HEAD has the tree id `tree`. */
export function cleanTree(tree: string = 'a1b2c3d4', commit: string = 'c0ffee12345'): CleanTree {
  return { kind: 'clean', tree, commit, gitDir: GIT_DIR };
}

/**
 * A working tree a test sets and changes: every look reads `state` (default no repository) and records its folder; a
 * step's look at the tree it runs on reads `ran` (default outside git) and records its folder in `ranLooks`.
 */
export class FakeTrees implements TreeState {
  readonly looks: string[] = [];
  readonly ranLooks: string[] = [];
  state: CheckedTree;
  ran: RunTree = { kind: 'outside' };

  constructor(state: CheckedTree = { kind: 'none' }) {
    this.state = state;
  }

  checked(dir: string): CheckedTree {
    this.looks.push(dir);
    return this.state;
  }

  ranIn(dir: string): RunTree {
    this.ranLooks.push(dir);
    return this.ran;
  }
}
