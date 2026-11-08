import type { Task } from '../register/fold.ts';
import { TASK_ID } from '../register/model.ts';

/**
 * What kind of work a queued step is: given with `queue --kind`, else read from its command (`kindOfCommand`); merge and
 * deploy name their own. A step's need is learned from the steps of its kind when its own label has no runs.
 */
export const STEP_KINDS = ['build', 'test', 'lint', 'push', 'merge', 'deploy', 'other'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export function isStepKind(value: unknown): value is StepKind {
  return STEP_KINDS.some((kind) => kind === value);
}

/** What a queued step asks for besides its label and session, recorded on its start and refusal records. */
export interface ProcessRequest {
  readonly kind: StepKind;
  /** The register task it works for: `queue --task`, else the first task id in its label (`taskOfLabel`). */
  readonly task?: string;
  /**
   * Its task's register priority when it queued (`p1` is 1, the most urgent): recorded only, as ordering the line by it
   * is admission's work (T2210).
   */
  readonly priority?: number;
}

/** A request of `kind` for `task` at the task's `priority`, each left out when unset; a priority is kept only with its task. */
export function processRequest(kind: StepKind, task: string | undefined, priority?: number): ProcessRequest {
  if (task === undefined) {
    return { kind };
  }
  return priority === undefined ? { kind, task } : { kind, task, priority };
}

/** The register's task as a request reads it: its priority. */
export type RequestTask = Pick<Task, 'priority'>;

/**
 * `request` with the register priority of the task it names, read by `taskOf`; unchanged when it names none, without
 * asking the register, or when the register has no such task (another team's, or a typo).
 */
export async function withTaskPriority(request: ProcessRequest, taskOf: (id: string) => Promise<RequestTask | undefined>): Promise<ProcessRequest> {
  if (request.task === undefined) {
    return request;
  }
  const task = await taskOf(request.task);
  return processRequest(request.kind, request.task, task?.priority);
}

/** A command word's program: its last path part in lower case, without a launcher's or a script's extension. */
function programOf(word: string): string {
  const last = word.split(/[\\/]/).pop() ?? word;
  return last.toLowerCase().replace(/\.(cmd|exe|bat|ps1|js|mjs|cjs|ts|mts)$/, '');
}

const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Programs whose run is one kind of work wherever they appear in a command (`npx eslint`, `node .../tsc.js`). */
const PROGRAM_KINDS: ReadonlyMap<string, StepKind> = new Map([
  ...['vitest', 'jest', 'mocha', 'ava', 'playwright', 'pytest'].map((program): [string, StepKind] => [program, 'test']),
  ...['eslint', 'biome', 'prettier', 'stylelint', 'lint-staged'].map((program): [string, StepKind] => [program, 'lint']),
  ...['tsc', 'webpack', 'esbuild', 'rollup', 'tsup'].map((program): [string, StepKind] => [program, 'build']),
]);

/** A package script's kind by its name's first part: `test:unit` tests, `lint` lints, `build` and `typecheck` build. */
function scriptKindOf(script: string): StepKind | undefined {
  const name = script.toLowerCase().split(':')[0] ?? '';
  if (name === 'test' || name === 't') {
    return 'test';
  }
  if (name === 'lint') {
    return 'lint';
  }
  return name === 'build' || name === 'typecheck' || name === 'tsc' ? 'build' : undefined;
}

/** Package runner flags whose next word is their value, not the script: `npm --prefix app test`, `pnpm -C app build`. */
const VALUED_FLAGS: ReadonlySet<string> = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace']);

/**
 * The kind of the script a package runner runs (`npm test`, `npm --prefix app run lint`, `pnpm build`): the word after
 * `run`, else its first word that is neither a flag nor a flag's value; undefined for another script.
 */
function packageScriptKindOf(words: readonly string[], runner: number): StepKind | undefined {
  const rest = words.slice(runner + 1);
  const run = rest.findIndex((word) => word === 'run' || word === 'run-script');
  const script = run >= 0 ? rest[run + 1] : rest.find((word, index) => !word.startsWith('-') && !VALUED_FLAGS.has(rest[index - 1] ?? ''));
  return script === undefined ? undefined : scriptKindOf(script);
}

/**
 * The kind of work a command does, read from its words: a `git ... push` pushes; `node --test`, a test runner or a
 * package's test script tests; a linter or a lint script lints; tsc, a bundler, or a build or typecheck script builds.
 * Anything else (a check that does all three, a script of the team's own) is `other`.
 */
export function kindOfCommand(words: readonly string[]): StepKind {
  const programs = words.map(programOf);
  const git = programs.indexOf('git');
  if (git >= 0 && programs.slice(git + 1).includes('push')) {
    return 'push';
  }
  if (words.includes('--test')) {
    return 'test';
  }
  for (const [index, program] of programs.entries()) {
    const kind = PACKAGE_RUNNERS.has(program) ? packageScriptKindOf(words, index) : PROGRAM_KINDS.get(program);
    if (kind !== undefined) {
      return kind;
    }
  }
  return 'other';
}

/** The first register task id a step's label names (`teamrig T2192 tests`); undefined when it names none. */
export function taskOfLabel(what: string): string | undefined {
  return what.split(/[^A-Za-z0-9]+/).find((word) => TASK_ID.test(word));
}
