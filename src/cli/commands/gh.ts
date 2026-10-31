import { ENV, KIT_NAME } from '../../core/home.ts';
import { addedTasks, type AddedTask, type RepoFailure } from '../../github/auto.ts';
import { importRules } from '../../github/map.ts';
import { importedTasks, planSync, type SyncPlan, type SyncStep } from '../../github/plan.ts';
import { applySteps, closedSince, readRepo, type StepOutcome } from '../../github/sync.ts';
import { RepoTokens, type RepoAccess } from '../../github/tokens.ts';
import { priorityText } from '../../register/model.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import { GITHUB_OFF, githubOff, reportAutoSync } from './gh-auto.ts';

/** The rows of steps a repository prints; the rest are counted. */
export const SHOWN_STEPS = 10;

/** The left-out issue numbers a repository's LEFT OUT line names; the rest are counted. */
export const SHOWN_LEFT_OUT = 20;

/** How the sync of one repository ended, for the exit code. */
type RepoEnd = 'ok' | 'failed' | 'refused';

/**
 * `gh sync [--repo <owner/name>] [--yes]`: brings the task list in step with the GitHub issues of the team's
 * `github.repos`, inbound only. Each owner's repositories are read with the read-only token saved for it
 * (github/tokens.ts), else the gh login, and an ACCESS line says which. gh only ever lists issues
 * (github/gh.ts refuses any other command), and the
 * register's import writes (register.ts) touch only the tasks it added, as `github`. Without `--yes` it
 * shows what it would write and writes nothing. Either way a LEFT OUT line names, by number only, the open
 * issues of a repository that the trust rule kept out (github/trust.ts). `--auto`, which the Stop hook starts (gh-auto.ts), writes as
 * `--yes` does and tells each owner's inbox its new tasks and the lead's when the failing repositories change. Exit 1 when a repository could not be read (its tasks stay
 * as they are), 2 when the register refused a step, else 0.
 */
export async function ghSync(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const auto = args.switches.has('auto');
  const write = auto || args.switches.has('yes');
  if (auto && args.flags.has('repo')) {
    throw new RefusedError('--auto reads every repository of github.repos, to know which still fail; leave out --repo');
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, write ? 'write' : 'read');
  const say = (line: string): void => runtime.out.stdout(line);
  if (githubOff(runtime.env)) {
    say(`OFF ${ENV.github}=${GITHUB_OFF} turns the GitHub import off on this machine; nothing was read or written`);
    return EXIT.ok;
  }
  if (config.github.repos.length === 0) {
    say('OFF no repository to read: list them as "owner/name" under github.repos in the team config; nothing was read or written');
    return EXIT.ok;
  }
  const register = teamRegister(runtime, kit.paths, config);
  const rules = importRules(config);
  const since = closedSince(new Date(runtime.clock.now()), config.github.closedDays);
  const tokens = new RepoTokens(runtime.credentials, runtime.env);
  const told = new Set<string>();
  const ends: RepoEnd[] = [];
  const added: AddedTask[] = [];
  const failures: RepoFailure[] = [];
  let written = 0;
  for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
    const { access, note } = await tokens.accessFor(repo);
    if (!told.has(access.owner)) {
      told.add(access.owner);
      say(accessLine(access, note));
    }
    const read = await readRepo(runtime.gh, access, repo, since);
    if (read.kind === 'failed') {
      say(`FAILED ${repo}: ${read.reason}; its tasks stay as they are`);
      ends.push('failed');
      failures.push({ repo, reason: read.reason });
      continue;
    }
    read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
    const plan = planSync(read.issues, importedTasks((await register.snapshot()).state.tasks.values()), rules);
    const leftOut = leftOutLines(repo, plan.leftOut, rules.acceptLabel);
    if (!write) {
      [...previewLines(repo, plan), ...leftOut].forEach(say);
      ends.push('ok');
      continue;
    }
    const outcomes = await applySteps(register, plan.steps);
    [...resultLines(repo, plan, outcomes), ...leftOut].forEach(say);
    written += outcomes.filter((outcome) => outcome.result.ok).length;
    added.push(...addedTasks(outcomes));
    const refused = refusedReason(outcomes);
    if (refused !== undefined) {
      failures.push({ repo, reason: refused });
    }
    ends.push(refused === undefined ? 'ok' : 'refused');
  }
  if (auto) {
    (await reportAutoSync(runtime, kit, config, added, failures)).forEach(say);
  }
  say(
    write
      ? `WROTE ${written} change(s) to the task list as ${GITHUB_ACTOR}; GitHub was only read`
      : `PREVIEW nothing was written; ${KIT_NAME} gh sync --yes writes the above as ${GITHUB_ACTOR}`,
  );
  return ends.includes('failed') ? EXIT.failed : ends.includes('refused') ? EXIT.refused : EXIT.ok;
}

/** Why the task list refused some of a repository's steps: how many, and the first one's error; undefined when none was. */
function refusedReason(outcomes: readonly StepOutcome[]): string | undefined {
  const errors = outcomes.flatMap((outcome) => (outcome.result.ok ? [] : [outcome.result.error]));
  return errors.length === 0 ? undefined : `the task list refused ${errors.length} step(s), first: ${errors[0]}`;
}

/** The repositories to read: every one of `github.repos`, or the one `--repo` names, which must be among them. */
function reposOf(repos: readonly string[], asked: string | undefined): readonly string[] {
  if (asked === undefined) {
    return repos;
  }
  const repo = asked.trim().toLowerCase();
  if (!repos.includes(repo)) {
    throw new RefusedError(`--repo ${asked} is not one of github.repos (${repos.join(', ')})`);
  }
  return [repo];
}

/** How an owner's repositories are read, said once per owner: a token by the name it is saved under, or the gh login and why. */
export function accessLine(access: RepoAccess, note: string | undefined): string {
  return access.via === 'token'
    ? `ACCESS ${access.owner}: read with the token saved as ${access.credential}`
    : `ACCESS ${access.owner}: read with the gh login; ${note ?? `no token saved as ${access.credential}`}`;
}

function previewLines(repo: string, plan: SyncPlan): string[] {
  return [
    `REPO ${repo}: ${plan.inserted} to add, ${plan.changed} to change, ${plan.unchanged} unchanged`,
    ...shown(plan.steps.map((step) => stepLine(step, step.kind === 'add' ? 'new' : step.id))),
  ];
}

function resultLines(repo: string, plan: SyncPlan, outcomes: readonly StepOutcome[]): string[] {
  const done = outcomes.filter((outcome) => outcome.result.ok);
  const added = done.filter((outcome) => outcome.step.kind === 'add').length;
  const changed = new Set(done.filter((outcome) => outcome.step.kind !== 'add').map((outcome) => outcome.step.ref)).size;
  const refused = outcomes.length - done.length;
  return [
    `REPO ${repo}: ${added} added, ${changed} changed, ${plan.unchanged} unchanged${refused > 0 ? `, ${refused} refused` : ''}`,
    ...shown(done.map((outcome) => stepLine(outcome.step, outcome.result.ok ? outcome.result.value : ''))),
    ...outcomes.flatMap((outcome) => (outcome.result.ok ? [] : [`SKIPPED ${outcome.step.ref}: ${outcome.result.error}`])),
  ];
}

/**
 * The line naming the open issues the trust rule (trust.ts) left out of a repository, and the label that lets
 * one in: their numbers only, as their text is an outsider's, at most SHOWN_LEFT_OUT and then how many more;
 * none when it left none out.
 */
function leftOutLines(repo: string, leftOut: readonly number[], acceptLabel: string): string[] {
  if (leftOut.length === 0) {
    return [];
  }
  const more = leftOut.length - SHOWN_LEFT_OUT;
  const numbers = leftOut.slice(0, SHOWN_LEFT_OUT).map((number) => `#${number}`).join(' ');
  return [
    `LEFT OUT ${repo}: ${leftOut.length} open issue(s) by people outside the repository wait for someone to add the ${JSON.stringify(acceptLabel)} label: ${numbers}${more > 0 ? ` and ${more} more` : ''}`,
  ];
}

/** The first SHOWN_STEPS lines, then how many more there are. */
function shown(lines: readonly string[]): string[] {
  const more = lines.length - SHOWN_STEPS;
  return more > 0 ? [...lines.slice(0, SHOWN_STEPS), `... and ${more} more`] : [...lines];
}

/** One step on one line; a title is outside input, so it is printed quoted, as data, and a description only by its length. */
export function stepLine(step: SyncStep, id: string): string {
  switch (step.kind) {
    case 'add':
      return `ADD ${id} ${step.ref} ${priorityText(step.input.priority)} ${step.input.owner}: ${JSON.stringify(step.input.title)}`;
    case 'update': {
      const { title, description, priority } = step.changes;
      const fields = [
        ...(title === undefined ? [] : [`title ${JSON.stringify(title)}`]),
        ...(description === undefined ? [] : [description === null ? 'description none' : `description (${description.length} characters)`]),
        ...(priority === undefined ? [] : [`priority ${priorityText(priority)}`]),
      ];
      return `UPDATE ${id} ${step.ref}: ${fields.join(', ')}`;
    }
    case 'status':
      return `SET ${id} ${step.ref} ${step.input.status}: ${step.input.note ?? ''}`;
  }
}
