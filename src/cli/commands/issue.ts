import { resolve } from 'node:path';
import { SecretScanner } from '../../core/secrets.ts';
import type { KitConfig } from '../../config/types.ts';
import { issueRef } from '../../sync/map.ts';
import { assignIssue, loginRefusal, MAX_ASSIGN_LOGINS } from '../../issues/assign.ts';
import { CLOSE_REASONS, hostKindOf, parseIssueTarget, targetText, type CloseReason, type HostKind, type IssueTarget } from '../../issues/host.ts';
import { bareRef, refOf } from '../../issues/ref.ts';
import { checkReply, sendReply, type FollowUp, type ReplyWrite } from '../../issues/reply.ts';
import { issueDoc, mirroredIssues, mirrorsIssue, similarIssues } from '../../issues/similar.ts';
import { holderOf, sessionLogins } from '../../issues/status-push.ts';
import { editIssueBody, labelIssue, labelRefusal, postRefusal, writeIssue, type IssueWrite } from '../../issues/write.ts';
import type { Task } from '../../register/fold.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import { secretRulesOf } from '../../secret-guard/rules.ts';
import { onePositional, requiredFlag, type Flags, type ParsedArgs } from '../args.ts';
import { withDescriptions } from '../card-texts.ts';
import { secretFilesOf } from '../host.ts';
import { callerOf } from '../inputs.ts';
import { hostsOf, type Hosts } from '../issue-hosts.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { CONNECTOR_OFF } from '../connector-off.ts';
import { githubOffBy } from './issue-sync-auto.ts';
import { set } from './register.ts';
import { openTeam } from './register-team.ts';

/**
 * `issue reply <owner/name#n> --body-file <path> [--status <status>] [--pr <n>] [--followup <title>
 * [--followup-body-file <path>]] [--assign <login,...>]` (T3169, replacing `issue comment`): a maintainer's reply that
 * takes the thread's state with its words, so a thread never says more than it shows (#922 read "Picking this up"
 * while still status:open, unassigned, its pull request unlinked). Through the host whose config list names the
 * repository (issues/host.ts; GitHub, github.repos, is the only one so far), with the checks every write has: the
 * caller on the team, no empty text, secret shape, private data or task id in what is posted.
 *
 * All reads come first and a refusal writes nothing: the thread, the `--pr` (an open pull request of the repository),
 * each `--assign` login. Then `--status` sets the task holding the issue through `teamrig set` (its own gates, and
 * `--note`, `--evidence`, `--skill`, `--followups`, `--waits`, `--proof` passed to it), and the reply sends the issue's
 * status from the register, the assignees, the pull request's link, the follow-up issue, and the comment last
 * (issues/reply.ts). On a pull request (no status of its own) it refuses `--status` and `--pr` and needs labels on
 * it. Exit 1 when the host failed, else 0.
 */
export async function issueReply(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const pull = pullOf(args.flags.get('pr'));
  const assign = labelsOf(args.flags.get('assign'), '--assign');
  const status = args.flags.get('status');
  const passed = SET_FLAGS.filter((name) => args.flags.has(name));
  if (status === undefined && passed.length > 0) {
    throw new RefusedError(`--${passed.join(', --')} go to the task with --status: give the status the reply sets`);
  }
  const checked = await checkedRepo(args, runtime, target.repo);
  const body = await bodyFileOf(requiredFlag(args.flags, 'body-file'), runtime, checked.config);
  const followup = await followupOf(args.flags, runtime, checked.config);
  const scanner = new SecretScanner(checked.config.register.secretPatterns);
  const followupRefused = followup === undefined ? undefined : (postRefusal('--followup', followup.title, scanner) ?? (followup.body === '' ? undefined : postRefusal('--followup-body-file', followup.body, scanner)));
  if (followupRefused !== undefined) {
    throw new RefusedError(followupRefused);
  }
  const hosts = await hostsAfter(checked, runtime, { flag: '--body-file', text: body });
  if (hosts === undefined) {
    return EXIT.ok;
  }
  const say = (line: string): void => runtime.out.stdout(line);
  const write: ReplyWrite = { target, body, assign, ...(pull === undefined ? {} : { pull }), ...(followup === undefined ? {} : { followup }) };
  const check = await checkReply(hosts.tracker, write, say);
  if (check.kind === 'refused') {
    throw new RefusedError(`${check.reason}; nothing was written`);
  }
  const logins = sessionLogins(checked.config.github.owners);
  if (check.reads.issue.pull) {
    if (status !== undefined) {
      throw new RefusedError(`${targetText(target)} is a pull request, which shows no status of its own: --status sets the issue it answers; nothing was written`);
    }
    return (await sendReply(hosts.tracker, write, check.reads, undefined, logins, say)) ? EXIT.ok : EXIT.failed;
  }
  const before = await holdingTask(runtime, target);
  if (status !== undefined) {
    const wanted = TASK_STATUS_OF_LABEL[status] ?? status;
    if (wanted !== before.status || passed.length > 0) {
      const setExit = await set({ command: 'set', positionals: [before.id], flags: setFlagsOf(args.flags, wanted, passed), switches: new Set(), rest: [], help: false, common: new Map() }, runtime);
      if (setExit !== EXIT.ok) {
        say(`STOPPED ${targetText(target)}: ${before.id} was not set, so nothing was written to the thread`);
        return setExit;
      }
    }
  }
  // Read again after the set: the status the thread shows is the one the register now holds.
  return (await sendReply(hosts.tracker, write, check.reads, await holdingTask(runtime, target), logins, say)) ? EXIT.ok : EXIT.failed;
}

/** The `teamrig set` flags `issue reply` passes on with `--status`. */
const SET_FLAGS = ['note', 'evidence', 'skill', 'followups', 'waits', 'proof'] as const;

/** The task status each status label word names, for `--status` given as the thread shows it. */
const TASK_STATUS_OF_LABEL: Readonly<Partial<Record<string, string>>> = { 'in review': 'verifying', 'in progress': 'in-progress', claimed: 'open' };

/** The flags of the `teamrig set` a reply runs: the status, the caller and each passed flag given. */
function setFlagsOf(flags: Flags, status: string, passed: readonly string[]): Flags {
  const out = new Map<string, string>([['status', status]]);
  for (const name of [...passed, 'session']) {
    const value = flags.get(name);
    if (value !== undefined) {
      out.set(name, value);
    }
  }
  return out;
}

/** The pull request number `--pr` gives, or undefined without it; refused when it is no number. */
function pullOf(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const number = /^#?([1-9][0-9]*)$/u.exec(text.trim())?.[1];
  if (number === undefined) {
    throw new RefusedError(`--pr ${text} is no pull request number: give the number of the pull request that answers the issue, such as --pr 1272`);
  }
  return Number(number);
}

/** The follow-up `--followup` names, its body from `--followup-body-file` (empty without it); refused when the body file comes alone. */
async function followupOf(flags: Flags, runtime: CliRuntime, config: KitConfig): Promise<FollowUp | undefined> {
  const title = flags.get('followup');
  const bodyFile = flags.get('followup-body-file');
  if (title === undefined) {
    if (bodyFile !== undefined) {
      throw new RefusedError('--followup-body-file is the body of the --followup issue: give its title with --followup');
    }
    return undefined;
  }
  return { title: title.trim(), body: bodyFile === undefined ? '' : await bodyFileOf(bodyFile, runtime, config) };
}

/**
 * The task holding the issue `target` as the status push picks it, refused when none does (the sync adds one) or when
 * two or more active tasks share it, as the push then writes nothing to it and the reply's status would be a guess.
 */
async function holdingTask(runtime: CliRuntime, target: IssueTarget): Promise<Task> {
  const team = await openTeam(runtime, 'read');
  const holder = holderOf(target, (await team.register.snapshot()).state.tasks.values());
  if (holder === undefined) {
    throw new RefusedError(`no task holds ${targetText(target)}, so the reply has no status to show: run teamrig issue sync, or add the task with --ref ${refOf(target)}; nothing was written`);
  }
  if (holder.kind === 'shared') {
    throw new RefusedError(`${holder.tasks.join(', ')} all hold ${targetText(target)}, so no one task's status speaks for it: finish or drop all but one, or move the others' --ref; nothing was written`);
  }
  return holder.task;
}

/**
 * `issue edit <owner/name#n> --body-file <path>` (T3021): replaces the body (the description) of one issue or pull
 * request of the team's repositories with the text of a file, through the same host and checks as `issue reply`;
 * the title, state, labels and assignees stay. A file is the input, as a full description runs to many lines a shell
 * argument would mangle; a byte-order mark an editor put at its start is dropped. Exit 1 when the host failed, else 0.
 */
export async function issueEdit(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const checked = await checkedRepo(args, runtime, target.repo);
  const body = await bodyFileOf(requiredFlag(args.flags, 'body-file'), runtime, checked.config);
  const hosts = await hostsAfter(checked, runtime, { flag: '--body-file', text: body });
  if (hosts === undefined) {
    return EXIT.ok;
  }
  return (await editIssueBody(hosts.tracker, { target, body }, (line) => runtime.out.stdout(line))) ? EXIT.ok : EXIT.failed;
}

/**
 * The text of the `--body-file` at `given`, resolved from the working folder, its byte-order mark dropped. A file the
 * secret guard keeps sessions from reading (secretGuard.paths with the defaults) is refused before it is read: the
 * guard sees a teamrig argument, not a file read, so without this the CLI would post a key file the text checks find
 * no shape in. The refusal names the flag, never the file's text.
 */
async function bodyFileOf(given: string, runtime: CliRuntime, config: KitConfig): Promise<string> {
  const path = resolve(runtime.cwd, given);
  if (secretRulesOf(config.secretGuard, runtime.userHome, runtime.platform, secretFilesOf(runtime)).paths.listed(path)) {
    throw new RefusedError(`--body-file names a file the secret guard keeps (secretGuard.paths): ${given} is never read or posted`);
  }
  const text = await runtime.files.read(path);
  if (text === undefined) {
    throw new RefusedError(`no file ${path}: --body-file takes the file holding the new body`);
  }
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

/** The mark some Windows editors write first in a UTF-8 file; it is no part of the text. */
const BYTE_ORDER_MARK = '﻿';

/**
 * `issue close <owner/name#n> [--comment <text>] [--reason completed|not-planned|duplicate] [--duplicate-of
 * <owner/name#n>]` (T2660, T2679, T2999): closes one issue or pull request of the team's repositories, first posting
 * `--comment` when given, through the same host and checks as `issue reply`; `--reason` is the one the host
 * shows. `--duplicate-of` closes it as a duplicate of another issue of the same repository, which the host links.
 * A failed comment closes nothing. Exit 1 when the host failed, else 0.
 */
export async function issueClose(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const comment = args.flags.get('comment');
  const given = closeReasonOf(args.flags.get('reason'));
  const duplicateOf = duplicateOfFlag(args.flags.get('duplicate-of'), target, given);
  const reason: CloseReason | undefined = duplicateOf === undefined ? given : 'duplicate';
  const write: IssueWrite = {
    target,
    close: true,
    ...(comment === undefined ? {} : { comment }),
    ...(reason === undefined ? {} : { reason }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
  return writeOn(args, runtime, write, '--comment');
}

/**
 * `issue label <owner/name#n> [--add <label,...>] [--remove <label,...>]` (T2679): adds labels to and takes labels
 * off one issue or pull request of the team's repositories, through the same host and caller checks as `issue
 * comment`. Each label to add must already be the repository's, or one it may make: teamrig's own, one its label file
 * names or one the team's github.areaOwners names (issues/write.ts); a label in both lists, or one no host takes, is
 * refused before anything runs. Exit 1 when the host failed, else 0.
 */
export async function issueLabel(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const add = labelsOf(args.flags.get('add'), '--add');
  const remove = labelsOf(args.flags.get('remove'), '--remove');
  if (add.length === 0 && remove.length === 0) {
    throw new RefusedError('issue label needs --add or --remove, each a comma-separated list of labels');
  }
  const both = add.find((label) => remove.includes(label));
  if (both !== undefined) {
    throw new RefusedError(`the label ${JSON.stringify(both)} is in both --add and --remove: give it in one`);
  }
  const checked = await checkedRepo(args, runtime, target.repo);
  const hosts = await hostsAfter(checked, runtime, undefined);
  if (hosts === undefined) {
    return EXIT.ok;
  }
  const areaLabels = Object.keys(checked.config.github.areaOwners);
  // The tracker holds the labels, the code host the repository's label file.
  return (await labelIssue(hosts.tracker, hosts.codeHost, { target, add, remove, areaLabels }, (line) => runtime.out.stdout(line))) ? EXIT.ok : EXIT.failed;
}

/**
 * `issue assign <owner/name#n> [--add <login,...>] [--remove <login,...>]` (T3228): adds assignees to and takes
 * them off one issue or pull request of the team's repositories, through the same host and caller checks as `issue
 * label`. Each login to add is read as one the host may assign to that item, and an add to a design issue is
 * refused (issues/assign.ts). Refused before anything runs: neither list, a login in both or no login at all, or more
 * than MAX_ASSIGN_LOGINS together. Exit 2 when refused, 1 when the host failed, else 0.
 */
export async function issueAssign(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const add = loginsOf(args.flags.get('add'), '--add');
  const remove = loginsOf(args.flags.get('remove'), '--remove');
  if (add.length === 0 && remove.length === 0) {
    throw new RefusedError('issue assign needs --add or --remove, each a comma-separated list of logins');
  }
  const both = add.find((login) => remove.some((other) => other.toLowerCase() === login.toLowerCase()));
  if (both !== undefined) {
    throw new RefusedError(`${both} is in both --add and --remove: give the login in one`);
  }
  if (add.length + remove.length > MAX_ASSIGN_LOGINS) {
    throw new RefusedError(`issue assign takes at most ${MAX_ASSIGN_LOGINS} logins in all, not ${add.length + remove.length}: an item goes to its takers`);
  }
  const hosts = await hostsFor(args, runtime, target.repo, undefined);
  if (hosts === undefined) {
    return EXIT.ok;
  }
  const end = await assignIssue(hosts.tracker, { target, add, remove }, (line) => runtime.out.stdout(line));
  return end === 'done' ? EXIT.ok : end === 'refused' ? EXIT.refused : EXIT.failed;
}

/** The logins of a comma-separated `flag`, each trimmed, a leading @ dropped, and named once in any case; refused when one is no login. */
function loginsOf(text: string | undefined, flag: string): string[] {
  if (text === undefined) {
    return [];
  }
  const logins: string[] = [];
  for (const given of text.split(',')) {
    const login = given.trim().replace(/^@/u, '');
    const refused = loginRefusal(login);
    if (refused !== undefined) {
      throw new RefusedError(`${flag}: ${refused}`);
    }
    if (!logins.some((one) => one.toLowerCase() === login.toLowerCase())) {
      logins.push(login);
    }
  }
  return logins;
}

/** The close reason `--reason` names, or undefined when it is not given; refused when it names none. */
function closeReasonOf(text: string | undefined): CloseReason | undefined {
  if (text === undefined) {
    return undefined;
  }
  const reason = CLOSE_REASONS.find((one) => one === text);
  if (reason === undefined) {
    throw new RefusedError(`--reason takes ${CLOSE_REASONS.join(', ')}, not ${JSON.stringify(text)}`);
  }
  return reason;
}

/** The labels of a comma-separated `flag`, each trimmed and named once; refused when one is no label name. */
function labelsOf(text: string | undefined, flag: string): string[] {
  if (text === undefined) {
    return [];
  }
  const labels = [...new Set(text.split(',').map((label) => label.trim()))];
  for (const label of labels) {
    const refused = labelRefusal(label);
    if (refused !== undefined) {
      throw new RefusedError(`${flag}: ${refused}`);
    }
  }
  return labels;
}

/**
 * The issue `--duplicate-of` names, or undefined when it is not given. Refused with a reason other than duplicate,
 * when it names no issue, the closed one itself, or one of another repository: the close's access is for its own.
 */
function duplicateOfFlag(text: string | undefined, target: IssueTarget, reason: CloseReason | undefined): IssueTarget | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (reason !== undefined && reason !== 'duplicate') {
    throw new RefusedError(`--duplicate-of closes as a duplicate, so it takes no --reason ${reason}`);
  }
  const original = parseIssueTarget(text);
  if (original === undefined) {
    throw new RefusedError(`--duplicate-of ${text} names no issue: give it as owner/name#number, such as acme/web#7`);
  }
  if (original.repo !== target.repo) {
    throw new RefusedError(`--duplicate-of names an issue of ${original.repo}: name one of ${target.repo}, the repository of the issue it closes`);
  }
  if (original.number === target.number) {
    throw new RefusedError(`--duplicate-of names ${targetText(target)} itself: name the issue it duplicates`);
  }
  return original;
}

/**
 * `issue similar <owner/name#n>` (T2695): the issues the register mirrors that may be duplicates of the one named, best
 * first (issues/similar.ts): TF-IDF over the mirrored titles and bodies, at most SIMILAR_TOP at or above
 * `github.similarThreshold`. It reads the register only, never the host, so the issue must be in it (`issue sync` adds
 * it). A snapshot's task line leaves the body out (T4781), so the bodies compared, the named issue's and the mirrored
 * ones', come from the history when any of them is cut (withDescriptions). Exit 0, with or without candidates.
 */
export async function issueSimilar(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const { config, register } = await openTeam(runtime, 'read');
  const working = await register.snapshot();
  const ref = issueRef(target.repo, target.number);
  const named = [...working.state.tasks.values()].find((task) => task.ref?.toLowerCase() === ref);
  if (named === undefined || named.ref === null) {
    throw new RefusedError(`${targetText(target)} is not in the task list: teamrig issue sync adds a task for each open issue of github.repos`);
  }
  const ownRef = named.ref;
  const now = new Date(runtime.clock.now());
  const mirrored = mirrorsIssue(now, config.github.closedDays);
  const read = await withDescriptions(working, () => register.history(), (task) => task.id === named.id || mirrored(task));
  const tasks = [...read.state.tasks.values()];
  const own = read.state.tasks.get(named.id) ?? named;
  const corpus = mirroredIssues(tasks, now, config.github.closedDays).filter((doc) => doc.ref !== ownRef);
  const threshold = config.github.similarThreshold;
  const matches = similarIssues(issueDoc(ownRef, own), corpus, threshold);
  const ids = new Map(tasks.flatMap((task) => (task.ref === null ? [] : [[task.ref, task.id] as const])));
  const found = matches.length === 0 ? 'none' : String(matches.length);
  runtime.out.stdout(`SIMILAR ${targetText(target)} (${own.id}): ${found} of ${corpus.length} mirrored issues at or above ${threshold} (github.similarThreshold)`);
  for (const match of matches) {
    runtime.out.stdout(`${match.score.toFixed(2)} ${bareRef(match.ref)} ${ids.get(match.ref) ?? '-'} ${match.title}`);
  }
  return EXIT.ok;
}

/** The issue or pull request the one positional names; refused when it names none. */
function targetOf(args: ParsedArgs): IssueTarget {
  const text = onePositional(args, 'issue');
  const target = parseIssueTarget(text);
  if (target === undefined) {
    throw new RefusedError(`${text} names no issue or pull request: give it as owner/name#number, such as acme/web#7`);
  }
  return target;
}

/** Checks the caller, the repository and the text, then writes through the repository's host. */
async function writeOn(args: ParsedArgs, runtime: CliRuntime, write: IssueWrite, textFlag: string): Promise<ExitCode> {
  const hosts = await hostsFor(args, runtime, write.target.repo, write.comment === undefined ? undefined : { flag: textFlag, text: write.comment });
  if (hosts === undefined) {
    return EXIT.ok;
  }
  return (await writeIssue(hosts.tracker, write, (line) => runtime.out.stdout(line))) ? EXIT.ok : EXIT.failed;
}

/**
 * The hosts of `repo` once the caller is on the team, the repository is one of the team's and the text to post (if
 * any) may be posted; undefined, after an OFF line, while GitHub is off on the machine.
 */
async function hostsFor(args: ParsedArgs, runtime: CliRuntime, repo: string, posted: Posted | undefined): Promise<Hosts | undefined> {
  return hostsAfter(await checkedRepo(args, runtime, repo), runtime, posted);
}

/** A text to post and the flag that gave it, which a refusal names. */
interface Posted {
  readonly flag: string;
  readonly text: string;
}

/** The team's config and the host kind of a repository the caller may write to. */
interface CheckedRepo {
  readonly config: KitConfig;
  readonly kind: HostKind;
}

/** The team's config and `repo`'s host kind once the caller is on the team and the repository is one of the team's. */
async function checkedRepo(args: ParsedArgs, runtime: CliRuntime, repo: string): Promise<CheckedRepo> {
  const team = await openTeam(runtime, 'read');
  const notOnTeam = new RegisterPolicy(team.config, team.above).checkCaller(sessionIdOf(team.roster, callerOf(args.flags, runtime.env)));
  if (notOnTeam !== undefined) {
    throw new RefusedError(notOnTeam);
  }
  const kind = hostKindOf(repo, team.config);
  if (kind === undefined) {
    const listed = team.config.github.repos.join(', ');
    throw new RefusedError(`${repo} is not one of the team's repositories: list it under github.repos in the team config${listed === '' ? '' : ` (now ${listed})`}`);
  }
  return { config: team.config, kind };
}

/** The hosts of a checked repository once the text to post (if any) may be posted; undefined, after an OFF line, while GitHub is off. */
async function hostsAfter(checked: CheckedRepo, runtime: CliRuntime, posted: Posted | undefined): Promise<Hosts | undefined> {
  const { config, kind } = checked;
  const scanner = new SecretScanner(config.register.secretPatterns);
  const refused = posted === undefined ? undefined : postRefusal(posted.flag, posted.text, scanner);
  if (refused !== undefined) {
    throw new RefusedError(refused);
  }
  const offBy = githubOffBy(runtime.env);
  if (offBy !== undefined) {
    runtime.out.stdout(`OFF ${offBy}=${CONNECTOR_OFF} turns GitHub off on this machine; nothing was written`);
    return undefined;
  }
  return hostsOf(kind, runtime, scanner, config.github.stamp, config.connectors);
}
