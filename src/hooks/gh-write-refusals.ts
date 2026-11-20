import type { ConfigLoad } from '../config/load.ts';
import { subcommandOf } from '../package-guard/runners.ts';
import type { LineRuns } from '../package-guard/programs.ts';
import { GIT_BUILTINS, GIT_VALUED_OPTIONS } from '../push-guard/invocations.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { ghRouteOf } from './gh-routes.ts';
import { ghCallOf, mayBeGhCall, repoFlagValue, type GhCall } from './gh-writes.ts';
import { changesVariable } from './variable-change.ts';

/**
 * The exec guard's check on raw `gh` (T3002, T4819): on the team's GitHub repositories (`github.repos`) raw gh only
 * reads. gh writes with whatever login its keyring holds, which may be another project's key that cannot write
 * there, and skips teamrig's check of who may; teamrig's own commands write with the key the team saved. So a write
 * placed on one of those repositories is refused, naming the teamrig command to run instead (hooks/gh-routes.ts), as
 * is a write the guard cannot place, and every write while the team config does not load. Other repositories keep
 * plain gh, so a contributor's own gh flow still works. It reads only the line's own words: a script it runs is not
 * covered, so it is a check against mistakes.
 */

/** The team's GitHub repositories, as the guard checks a raw `gh` write against them. */
export type GithubRepos =
  /** `github.repos` names none: raw `gh` passes, as on a project of no team. */
  | { readonly kind: 'none' }
  /** The team config did not load, so the guard cannot tell which repositories are the team's: it refuses every raw `gh` write. */
  | { readonly kind: 'unknown'; readonly why: string }
  | { readonly kind: 'repos'; readonly repos: ReadonlySet<string> };

/** What the check reads besides the line. */
export interface GhWriteEnv {
  readonly github: GithubRepos;
  /** The GitHub repositories (`owner/name`, lowercase) a folder's git remotes name; undefined when git cannot tell. */
  readonly remotesOf: (dir: string) => readonly string[] | undefined;
  /** The hook's `GH_REPO`, which gh takes over the folder's remotes; undefined when it is unset. */
  readonly ghRepo: string | undefined;
}

/** The repositories the guard checks raw `gh` writes against, from the team config's load; a config that did not load fails closed. */
export function githubReposOf(load: ConfigLoad | undefined): GithubRepos {
  if (load === undefined || load.status !== 'loaded') {
    return { kind: 'unknown', why: load?.status === 'missing' ? 'the team config is missing' : 'the team config did not load' };
  }
  const { repos } = load.config.github;
  return repos.length === 0 ? { kind: 'none' } : { kind: 'repos', repos: new Set(repos.map((repo) => repo.toLowerCase())) };
}

/** The git commands that may change which repository a folder's remotes name before gh reads them. */
const REMOTE_CHANGES: ReadonlySet<string> = new Set(['remote', 'config', 'clone', 'init']);

/** The variables that change which repository gh or git picks for a folder: set on the line, they leave it in doubt. */
const PLACING_VARIABLES: readonly string[] = ['GH_REPO', 'GH_HOST', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];

/**
 * True when the line may change the repository a folder's gh write lands on before gh reads it: a variable gh or git
 * places it by; a git run, or an unnamed program, naming a command that changes remotes, or one only known when it
 * runs; or a git command that is none of git's own, which may be an alias or a `git-<name>` program doing anything
 * (git never lets an alias override its own commands).
 */
function placementInDoubt(runs: LineRuns): boolean {
  if (PLACING_VARIABLES.some((name) => changesVariable(runs, name))) {
    return true;
  }
  const gitArgs = runs.programs.filter((run) => run.name === 'git').map((run) => run.args);
  const outsideGit = gitArgs.some((args) => {
    const { name } = subcommandOf(args, GIT_VALUED_OPTIONS);
    return name !== undefined && !GIT_BUILTINS.has(name);
  });
  return outsideGit || [...gitArgs, ...runs.opaque.map((run) => run.args)].some((args) => args.some((word) => word.dynamic || REMOTE_CHANGES.has(word.text)));
}

/** The `teamrig issue` commands, so a call through a program only known when it runs (`$T issue reply o/n#7`) reads as teamrig's, not gh's. */
export const ISSUE_COMMANDS: ReadonlySet<string> = new Set(['sync', 'watch', 'migrate', 'reply', 'edit', 'close', 'label', 'similar', 'assign', 'links']);

/** The `teamrig issue` commands gh's issue group has too; teamrig's alone names its issue as `owner/name#n`, which gh never takes. */
const SHARED_ISSUE_COMMANDS: ReadonlySet<string> = new Set(['edit', 'close']);

/** True when an unnamed program's words read as a `teamrig issue` call rather than a gh one. */
function teamrigIssueCall(words: readonly ShellWord[]): boolean {
  const [group, command] = words;
  if (group?.text !== 'issue' || group.dynamic || command === undefined || command.dynamic || !ISSUE_COMMANDS.has(command.text)) {
    return false;
  }
  return !SHARED_ISSUE_COMMANDS.has(command.text) || words.slice(2).some((word) => !word.dynamic && /^[^/#\s]+\/[^/#\s]+#\d+$/u.test(word.text));
}

/** The repositories gh picks one from for a write that names none: `GH_REPO`, else the folder's remotes; undefined when the guard cannot tell. */
function folderReposOf(dir: string | undefined, env: GhWriteEnv, doubt: boolean): readonly string[] | undefined {
  if (doubt) {
    return undefined;
  }
  if (env.ghRepo !== undefined && env.ghRepo !== '') {
    const repo = repoFlagValue(env.ghRepo);
    return repo === undefined ? undefined : [repo];
  }
  return dir === undefined ? undefined : env.remotesOf(dir);
}

/** A gh write, what the guard tells the session to run instead, and where a write that names no repository lands. */
interface GhWrite {
  readonly call: Exclude<GhCall, { readonly kind: 'read' }>;
  readonly route: string;
  readonly folder: () => readonly string[] | undefined;
}

/** Why the guard refuses a raw `gh` write, or undefined when it lands on no repository of the team. */
function ghRefusalOf({ call, route, folder }: GhWrite, github: Exclude<GithubRepos, { readonly kind: 'none' }>): string | undefined {
  const instead = `Run teamrig's instead, which writes with the team's saved GitHub key: ${route}.`;
  if (github.kind === 'unknown') {
    return `\`${call.what}\` writes on GitHub, and ${github.why}, so the guard cannot tell whether it reaches one of the team's repositories; fix the config. ${instead}`;
  }
  if (call.kind === 'unplaced') {
    return `\`${call.what}\` writes with this machine's own gh login, and ${call.why}, so the guard cannot tell whether it reaches one of the team's repositories. ${instead}`;
  }
  const fromFolder = call.target.folder ? folder() : [];
  if (fromFolder === undefined) {
    return `\`${call.what}\` writes on the repository of the folder it runs in (or \`GH_REPO\`), which the guard cannot read: the line may change it, git cannot tell, or a remote reaches GitHub in a form the guard cannot read (an SSH alias, a port); name the repository with \`-R\`. On one of the team's: ${route}.`;
  }
  const hit = [...new Set([...call.target.repos, ...fromFolder])].filter((repo) => github.repos.has(repo));
  return hit.length === 0
    ? undefined
    : `\`${call.what}\` writes on ${hit.join(', ')}, a repository of the team, with this machine's own gh login, not the team's saved key, and past teamrig's check of who may. ${instead}`;
}

/**
 * Why the guard refuses each raw `gh` write on the line: its `gh` runs, and each program only known when it runs whose
 * words read as a gh call (`$GH issue close 7`), which has no folder the guard can tell. Reads always pass, and so does
 * every call on a team whose `github.repos` names none.
 */
export function ghWriteRefusals(runs: LineRuns, env: GhWriteEnv): string[] {
  const github = env.github;
  if (github.kind === 'none') {
    return [];
  }
  const calls: readonly { readonly args: readonly ShellWord[]; readonly dir: string | undefined }[] = [
    ...runs.programs.filter((run) => run.name === 'gh').map((run) => ({ args: run.args, dir: run.dir })),
    ...runs.opaque.filter((run) => mayBeGhCall(run.args) && !teamrigIssueCall(run.args)).map((run) => ({ args: run.args, dir: undefined })),
  ];
  if (calls.length === 0) {
    return [];
  }
  const doubt = placementInDoubt(runs);
  return calls.flatMap(({ args, dir }) => {
    const call = ghCallOf(args);
    const why = call.kind === 'read' ? undefined : ghRefusalOf({ call, route: ghRouteOf(args), folder: () => folderReposOf(dir, env, doubt) }, github);
    return why === undefined ? [] : [why];
  });
}
