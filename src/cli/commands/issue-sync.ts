import { ENV, KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { addedTasks, type AddedTask, type RepoFailure } from '../../github/auto.ts';
import { importRules } from '../../github/map.ts';
import { importedTasks, linkedRefs, planSync, type SyncPlan, type SyncStep } from '../../github/plan.ts';
import { eventsByRecipient, pullEvents, pullNewsText, pullRecipient, type PullEvent, type PullWatch } from '../../github/pull-news.ts';
import { applySteps, closedSince, type StepOutcome } from '../../github/sync.ts';
import type { IssueHost } from '../../issues/host.ts';
import { autoPushWrites, sessionLogins } from '../../issues/status-push.ts';
import { priorityText } from '../../register/model.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { hostOf, reposOf } from '../issue-hosts.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import type { Thread } from '../../github/clock.ts';
import type { HostIssue } from '../../issues/issue.ts';
import { claimBudget, recordClaims } from './issue-claim.ts';
import { recordClocks, repoThreads } from './issue-clock.ts';
import { issuePush, pushEndLine, pushRepos } from './issue-push.ts';
import { GITHUB_OFF, githubOff, readSyncState, reportAutoSync } from './issue-sync-auto.ts';

/** The rows of steps a repository prints; the rest are counted. */
export const SHOWN_STEPS = 10;

/** The left-out issue numbers a repository's LEFT OUT line names; the rest are counted. */
export const SHOWN_LEFT_OUT = 20;

/** How the sync of one repository ended, for the exit code. */
type RepoEnd = 'ok' | 'failed' | 'refused';

/**
 * `issue sync [--repo <owner/name>] [--yes]`: brings the task list in step with the GitHub issues of the team's
 * `github.repos`, inbound; `--push` plans the outbound half instead (issue-push.ts). Each repository is listed through the issue host port (issues/host.ts; on GitHub
 * with the token saved for its owner, else, when none is saved, the gh login), and an ACCESS line says which, once
 * per owner; a saved token the store could not read fails that owner's repositories, never read through the login
 * instead. A sync only lists issues, and the
 * register's import writes (register.ts) touch only the tasks it added, as `github`. Without `--yes` it
 * shows what it would write and writes nothing. Either way a LEFT OUT line names, by number only, the open
 * issues of a repository that the trust rule kept out (github/trust.ts). `--auto`, which the watch runs when GitHub changed (issue-watch.ts), writes as
 * `--yes` does and tells each owner's inbox its new tasks, and the lead's when the failing repositories change or
 * an issue is newly left out. Each repository's pull requests are read too and compared with what the last
 * `--auto` read of them (pull-news.ts): a PULL NEWS line per session names what happened since, but only `--auto`
 * keeps what it read and tells each session's inbox, so a run by hand changes nothing there. Exit 1 when a
 * repository could not be read (its tasks stay as they are, and its pull request watch), 2 when the register
 * refused a step, else 0.
 */
export async function issueSync(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  if (args.switches.has('push')) {
    return issuePush(args, runtime);
  }
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
  const started = runtime.clock.now();
  const since = closedSince(new Date(started), config.github.closedDays);
  const pushing = auto && config.github.statusPush;
  /** The issues of each repository read, for the claim pass, which writes to GitHub only when the run pushes. */
  const claimRead = new Map<string, readonly HostIssue[]>();
  // github.repos is GitHub's list, so every repository it names is GitHub's.
  const host = hostOf('github', runtime, new SecretScanner(config.register.secretPatterns));
  const told = new Set<string>();
  const ends: RepoEnd[] = [];
  const added: AddedTask[] = [];
  const failures: RepoFailure[] = [];
  const leftOut = new Map<string, readonly number[]>();
  const unread = new Set<string>();
  const watched = (await readSyncState(runtime, kit))?.pulls ?? new Map<string, PullWatch>();
  const pulls = new Map<string, PullWatch>();
  const pullNews: PullEvent[] = [];
  let written = 0;
  /** The open threads of the repositories read, for the response clock, and those repositories. */
  const threads: Thread[] = [];
  const clocked = new Set<string>();
  for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
    const reach = await host.reach(repo, 'read');
    if (reach.kind === 'unreachable') {
      say(`FAILED ${repo}: ${reach.reason}; its tasks stay as they are`);
      ends.push('failed');
      failures.push({ repo, reason: reach.reason });
      unread.add(repo);
      continue;
    }
    if (!told.has(reach.scope)) {
      told.add(reach.scope);
      say(`ACCESS ${reach.access}`);
    }
    const read = await host.list(repo, since);
    if (read.kind === 'failed') {
      say(`FAILED ${repo}: ${read.reason}; its tasks stay as they are`);
      ends.push('failed');
      failures.push({ repo, reason: read.reason });
      unread.add(repo);
      continue;
    }
    read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
    const tasks = [...(await register.snapshot()).state.tasks.values()];
    const plan = planSync(read.issues, importedTasks(tasks), rules, linkedRefs(tasks));
    leftOut.set(repo, plan.leftOut);
    const leftOutText = leftOutLines(repo, plan.leftOut, rules.acceptLabel);
    let end: RepoEnd = 'ok';
    if (write) {
      const outcomes = await applySteps(register, plan.steps);
      // Against the tasks as written, so an issue the import just took is held by its new task.
      threads.push(...repoThreads(read.issues, [...(await register.snapshot()).state.tasks.values()], rules));
      clocked.add(repo);
      claimRead.set(repo, read.issues);
      [...resultLines(repo, plan, outcomes), ...leftOutText].forEach(say);
      written += outcomes.filter((outcome) => outcome.result.ok).length;
      added.push(...addedTasks(outcomes));
      const refused = refusedReason(outcomes);
      if (refused !== undefined) {
        failures.push({ repo, reason: refused });
        end = 'refused';
      }
    } else {
      [...previewLines(repo, plan), ...leftOutText].forEach(say);
    }
    const watch = await readPulls(host, repo, watched.get(repo));
    watch.lines.forEach(say);
    if (watch.kind === 'failed') {
      if (end === 'ok') {
        failures.push({ repo, reason: watch.reason });
      }
      ends.push('failed');
      continue;
    }
    pulls.set(repo, watch.after);
    pullNews.push(...watch.events);
    ends.push(end);
  }
  const owners = new Map([...(await register.snapshot()).state.tasks.values()].map((task) => [task.id, task.owner]));
  const watcher = config.github.watcher ?? config.roles.lead;
  const news = eventsByRecipient(pullNews, (pull) => pullRecipient(pull, (task) => owners.get(task), watcher));
  for (const [to, events] of news) {
    const { text, wake } = pullNewsText(events);
    say(`PULL NEWS ${to}${wake ? ' (wakes)' : ''}: ${text}`);
  }
  if (write) {
    (await recordClocks(runtime, kit, config, clocked, threads)).forEach(say);
  }
  if (pushing) {
    const writesPerRun = autoPushWrites(config.github.probeSeconds);
    // Before the push, so it plans against the assignees the claims set; the claims' writes share the run's budget.
    const claimed = await recordClaims(runtime, kit, config, { host, read: claimRead, started, writes: claimBudget(writesPerRun) });
    claimed.lines.forEach(say);
    // The import's tasks are in the register now, so the push plans against them. A repository the import could
    // not read is not pushed: it would fail the same way, and its failure is already told.
    const pushed = await pushRepos(
      {
        host,
        repos: config.github.repos.filter((repo) => !unread.has(repo)),
        since,
        tasks: async () => (await register.snapshot()).state.tasks.values(),
        send: true,
        // No closes: the automatic push sends labels and assignees only (security verdict F1 on T2876); it prints each close held.
        limits: { writesPerRun: Math.max(0, writesPerRun - claimed.writes), closes: false },
        logins: sessionLogins(config.github.owners),
        told,
      },
      say,
    );
    say(pushEndLine(true, pushed, writesPerRun));
    for (const failure of pushed.failures) {
      ends.push('failed');
      // One failure per repository, so the lead is told a repository fails once; the first reason stands.
      if (!failures.some((known) => known.repo === failure.repo)) {
        failures.push({ repo: failure.repo, reason: `status push: ${failure.reason}` });
      }
    }
  }
  if (auto) {
    (await reportAutoSync(runtime, kit, config, { added, failures, leftOut, pulls, pullNews: news })).forEach(say);
  } else if (news.size > 0) {
    say(`NOTE only ${KIT_NAME} issue sync --auto tells the pull request news and keeps what it read, so the next run names it again`);
  }
  say(
    write
      ? `WROTE ${written} change(s) to the task list as ${GITHUB_ACTOR}${pushing ? '' : '; GitHub was only read'}`
      : `PREVIEW nothing was written; ${KIT_NAME} issue sync --yes writes the above as ${GITHUB_ACTOR}`,
  );
  return ends.includes('failed') ? EXIT.failed : ends.includes('refused') ? EXIT.refused : EXIT.ok;
}

/** One repository's pull request read: the lines it prints, and why it failed or what it read and the events since the last read. */
type PullRead =
  | { readonly kind: 'failed'; readonly reason: string; readonly lines: readonly string[] }
  | { readonly kind: 'read'; readonly after: PullWatch; readonly events: readonly PullEvent[]; readonly lines: readonly string[] };

/**
 * Reads `repo`'s pull requests and compares them with `before`, the watch the last `--auto` run kept (pull-news.ts).
 * The first read of a repository only marks, so the news starts with the next one.
 */
async function readPulls(host: IssueHost, repo: string, before: PullWatch | undefined): Promise<PullRead> {
  const read = await host.pulls(repo, before?.cursor);
  if (read.kind === 'failed') {
    const reason = `pull requests: ${read.reason}`;
    return { kind: 'failed', reason, lines: [`FAILED ${repo} ${reason}; what was last read of them stays`] };
  }
  const step = pullEvents(before, read.open, read.changed);
  return { kind: 'read', after: step.after, events: step.events, lines: read.notes.map((note) => `NOTE ${repo}: ${note}`) };
}

/** Why the task list refused some of a repository's steps: how many, and the first one's error; undefined when none was. */
function refusedReason(outcomes: readonly StepOutcome[]): string | undefined {
  const errors = outcomes.flatMap((outcome) => (outcome.result.ok ? [] : [outcome.result.error]));
  return errors.length === 0 ? undefined : `the task list refused ${errors.length} step(s), first: ${errors[0]}`;
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
export function shown(lines: readonly string[]): string[] {
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
