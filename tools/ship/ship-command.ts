import { errorMessage } from '../../src/core/guards.ts';
import { shipCommits, type ShipDeps } from './ship-commits.ts';
import { parseShipArgs, readPlan } from './ship-plan.ts';

/** The deps a ship of one teamrig dir runs on, built once its arguments are read; ship.ts wires the real ones. */
export type ShipDepsFor = (repo: string, noteFile: string | null) => ShipDeps;

/**
 * The exit code of `ship.ts <teamrig dir> <plan.json> ...`: reads the arguments and the plan, then ships
 * (ship-commits.ts). A refusal or failure is one line on `err`, never a stack; bad arguments or a bad plan
 * are refused before any deps are built.
 */
export async function shipCommand(argv: readonly string[], depsFor: ShipDepsFor, err: (line: string) => void): Promise<number> {
  try {
    const args = parseShipArgs(argv);
    const written = readPlan(args.plan);
    return await shipCommits(args, written, depsFor(args.repo, args.noteFile));
  } catch (error) {
    err(errorMessage(error));
    return 1;
  }
}
