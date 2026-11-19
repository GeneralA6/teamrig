import type { Env } from '../core/home.ts';
import type { ProgramRunner } from '../core/program-runner.ts';
import type { GhRunner } from './gh.ts';

/**
 * The two ways across between a `gh` runner and a program runner. A connector adapter is handed a program runner
 * and nothing else to reach its tool with (plugin-api/connector.ts), while the GitHub code still asks a GhRunner,
 * and the CLI's own (gh.ts: the allow list, the output cap, the label-file memory) must stay the one every `gh` run
 * passes. So the CLI hands the adapter its GhRunner as a program runner, and the adapter reads it back as a
 * GhRunner. A seam, here until src/github moves into the adapter and the adapter keeps those rules itself.
 */

/** The program the GitHub CLI is run as. */
export const GH_PROGRAM = 'gh';

/** A program runner was asked for a program other than the one it runs. */
export class NotGhError extends Error {
  override readonly name = 'NotGhError';

  constructor(program: string) {
    super(`this runner runs ${GH_PROGRAM} alone, not ${program}`);
  }
}

/** `run` as a GhRunner: each request goes out as one run of `gh`, in the request's environment. */
export function ghOverProgram(run: ProgramRunner): GhRunner {
  return { run: ({ args, env }) => run({ program: GH_PROGRAM, args, env }) };
}

/**
 * `gh` as a program runner: a request for `gh` goes to it, in the request's environment or in `env` when it sets
 * none; a request for any other program rejects with NotGhError, so the adapter it is handed to runs nothing else.
 */
export function programOverGh(gh: GhRunner, env: Env): ProgramRunner {
  return (request) => (request.program === GH_PROGRAM ? gh.run({ args: request.args, env: request.env ?? env }) : Promise.reject(new NotGhError(request.program)));
}
