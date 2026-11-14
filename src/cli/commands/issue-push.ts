import { ENV } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { closedSince } from '../../github/sync.ts';
import { targetText } from '../../issues/host.ts';
import { applyPush } from '../../issues/push-apply.ts';
import { changeLine, changeWrites, PUSH_WRITES_PER_RUN, planPush, type PushPlan } from '../../issues/status-push.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { hostOf, reposOf } from '../issue-hosts.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './issue-sync-auto.ts';
import { openTeam } from './register-team.ts';

/** The change rows a repository prints; the rest are counted. */
export const SHOWN_CHANGES = 10;

/**
 * `issue sync --push [--repo <owner/name>] [--yes]` (T2682, T2876): the outbound half of issue sync. For each issue
 * of the team's `github.repos` a task holds, it plans the writes that make the issue show the task's status
 * (issues/status-push.ts) against the issue as the host lists it now, and prints them. Without --yes it writes
 * nothing, the dry run to read before a push; with --yes a session on the team sends each repository's plan
 * (issues/push-apply.ts), at most PUSH_WRITES_PER_RUN writes, a repository stopping at its first failure. Exit 1
 * when a repository could not be read or a write failed, else 0.
 */
export async function issuePush(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  if (args.switches.has('auto')) {
    throw new RefusedError('--auto imports issues; the push is run by hand: leave out --auto');
  }
  const send = args.switches.has('yes');
  const team = await openTeam(runtime, 'read');
  const config = team.config;
  if (send) {
    const notOnTeam = new RegisterPolicy(config, team.above).checkCaller(sessionIdOf(team.roster, callerOf(args.flags, runtime.env)));
    if (notOnTeam !== undefined) {
      throw new RefusedError(notOnTeam);
    }
  }
  const say = (line: string): void => runtime.out.stdout(line);
  if (githubOff(runtime.env)) {
    say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was read or written`);
    return EXIT.ok;
  }
  if (config.github.repos.length === 0) {
    say('OFF no repository to push to: list them as "owner/name" under github.repos in the team config; nothing was read or written');
    return EXIT.ok;
  }
  const since = closedSince(new Date(runtime.clock.now()), config.github.closedDays);
  // github.repos is GitHub's list, so every repository it names is GitHub's.
  const host = hostOf('github', runtime, new SecretScanner(config.register.secretPatterns));
  const told = new Set<string>();
  let failed = false;
  let writes = 0;
  let sent = 0;
  for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
    const reach = await host.reach(repo, send ? 'write' : 'read');
    if (reach.kind === 'unreachable') {
      say(`FAILED ${repo}: ${reach.reason}; nothing planned for it`);
      failed = true;
      continue;
    }
    if (!told.has(reach.scope)) {
      told.add(reach.scope);
      say(`ACCESS ${reach.access}`);
    }
    const read = await host.list(repo, since);
    if (read.kind === 'failed') {
      say(`FAILED ${repo}: ${read.reason}; nothing planned for it`);
      failed = true;
      continue;
    }
    read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
    const plan = planPush(repo, read.issues, (await team.register.snapshot()).state.tasks.values());
    planLines(plan).forEach(say);
    if (!send) {
      writes += plan.changes.reduce((sum, change) => sum + changeWrites(change), 0);
      continue;
    }
    const outcome = await applyPush(host, plan, say);
    writes += outcome.writes;
    sent += outcome.sent;
    failed ||= outcome.failed !== undefined;
  }
  say(
    send
      ? `PUSHED ${sent} change(s), ${writes} write(s); at most ${PUSH_WRITES_PER_RUN} a run, the rest planned again on the next`
      : `PREVIEW nothing was written; a push would send ${writes} write(s) now, at most ${PUSH_WRITES_PER_RUN} a run, and plan the rest again on the next`,
  );
  return failed ? EXIT.failed : EXIT.ok;
}

/** A repository's plan: its counts, the changes this run sends, then each issue the push leaves as it is and why. */
export function planLines(plan: PushPlan): string[] {
  const counts = [
    `${plan.changes.length} to change`,
    `${plan.unchanged} unchanged`,
    ...(plan.deferred.length === 0 ? [] : [`${plan.deferred.length} left for the next run`]),
    ...(plan.closedActive.length === 0 ? [] : [`${plan.closedActive.length} closed on the host while the task is active`]),
    ...(plan.unlisted.length === 0 ? [] : [`${plan.unlisted.length} not listed`]),
  ];
  const changes = plan.changes.map(changeLine);
  const more = changes.length - SHOWN_CHANGES;
  return [
    `PUSH ${plan.repo}: ${counts.join(', ')}`,
    ...(more > 0 ? [...changes.slice(0, SHOWN_CHANGES), `... and ${more} more`] : changes),
    ...plan.closedActive.map(
      (closed) =>
        `KEPT ${targetText(closed.target)} ${closed.task} ${closed.status}: closed on the host${closed.stateReason === '' ? '' : ` (${closed.stateReason.toLowerCase()})`} while the task is active; the push never reopens an issue, so set the task to match or reopen the issue`,
    ),
    ...plan.unlisted.map((held) => `UNLISTED ${targetText(held.target)} ${held.task} ${held.status}: not open on the host (closed before github.closedDays, or gone) while the task is active; the push never reopens an issue`),
  ];
}
