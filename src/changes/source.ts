/**
 * The change-source port (T3424): where `teamrig changes` reads what changed in a project. Each source is one way a
 * project records its changes (teamrig's register and git, its own `changes/<slug>.md` notes, and behind T3426 the
 * third-party ones: changesets, release-please, a Keep a Changelog CHANGELOG.md, GitHub releases).
 *
 * A source declares what it can filter by (`capabilities`); the core filters the rest itself after the read, so a
 * source that cannot read by file is still usable with `--file`, it just returns every entry and the core drops the
 * ones naming no matching file. A source never throws for a project it does not apply to: `detect` says false, and
 * a read that failed is `{ kind: 'failed' }`, so one broken source never hides the others' entries.
 *
 * Adapters go in `src/changes/sources/<id>.ts`, each with `<id>.test.ts` on fixture files, its deps built by
 * `changeDepsOf` (src/testing/fake-change-git.ts) over MemoryFiles, FakeGh and FakeChangeGit.
 */
import type { Files } from '../core/files.ts';
import type { GhRunner } from '../github/gh.ts';
import type { NoAccessError, RepoAccess } from '../github/tokens.ts';

/** Who an entry is for: `lead` shows only at the lead's start, `all` also goes to each session's inbox (T3425). */
export type ChangeAudience = 'lead' | 'all';

/**
 * What the reader must make of it. `action`: they must do something (a config line, a restart, a rename); shown in
 * full. `behaviour`: something they rely on works differently; shown in full. The rest are counted per area at a
 * lead's start and listed in full by `teamrig changes`.
 */
export type ChangeKind = 'action' | 'behaviour' | 'feature' | 'fix' | 'other';

/** One change, as every source returns it. */
export interface ChangeEntry {
  /** The id of the source that read it (`ChangeSource.id`), so a reader sees where each line came from. */
  readonly source: string;
  /** The release it shipped in, as the project writes its versions ('0.453.0'); undefined when not released yet. */
  readonly version: string | undefined;
  /** When it landed (ISO 8601, UTC); undefined when the source does not know. */
  readonly at: string | undefined;
  /** The area it touches, short and lower-case ('idle', 'config', 'open'); 'general' when the source has none. */
  readonly area: string;
  readonly kind: ChangeKind;
  readonly audience: ChangeAudience;
  /** The change in one or two sentences of Markdown, written for a user of the project, not its developers. */
  readonly text: string;
  /** For kind 'action': the step to take, one line. */
  readonly action: string | undefined;
  /** Repository-relative paths it changed, when the source knows them. */
  readonly files: readonly string[];
  /** What a reader can look up: task ids ('T3387'), pull requests ('#1373'), commit shas, release URLs. */
  readonly refs: readonly string[];
}

/** One end of the asked range, as the user wrote it: `--since 0.447.0` or `--since 2026-11-16`. */
export type ChangePoint = { readonly kind: 'version'; readonly version: string } | { readonly kind: 'date'; readonly at: string };

/**
 * The read the core asks of a source. `since` and `until` arrive resolved to both a version and a time where the
 * core could (from the project's release index, `ChangeGit.releases`), so a source that reads
 * only by date still answers a `--since <version>` ask. `file` and `area` are passed only to a source whose
 * capabilities say it filters by them; otherwise they are undefined and the core filters.
 */
export interface ChangeQuery {
  readonly since: ResolvedPoint;
  /** Undefined: up to now. */
  readonly until: ResolvedPoint | undefined;
  /** A repository-relative path or folder prefix ('src/open/'). */
  readonly file: string | undefined;
  readonly area: string | undefined;
}

export interface ResolvedPoint {
  readonly version: string | undefined;
  readonly at: string | undefined;
  /** The release's commit, when the point is a release the project's history names: a range by commit is exact, one by time is not. */
  readonly ref: string | undefined;
}

/** What a source can narrow by itself; the core does the rest. */
export interface ChangeSourceCapabilities {
  /** It reads a range given by version. */
  readonly byVersion: boolean;
  /** It reads a range given by time. */
  readonly byDate: boolean;
  /** It narrows to entries touching a file or folder. */
  readonly byFile: boolean;
  /** It narrows to one area. */
  readonly byArea: boolean;
  /** Its entries carry a real audience and kind, not the defaults 'lead' and 'other'. */
  readonly classified: boolean;
}

export type ChangeRead =
  /** : each part it could not read (a file and line, a heading with no version), printed under the entries. */
  /** `warnings`: each part it could not read (a file and line, a heading with no version), printed under the entries. */
  | { readonly kind: 'read'; readonly entries: readonly ChangeEntry[]; readonly warnings: readonly string[] }
  | { readonly kind: 'failed'; readonly error: string };

/** What a source may use; nothing else, so its specs run on fakes. GitHub goes only through teamrig's own key. */
export interface ChangeSourceDeps {
  readonly files: Files;
  readonly git: ChangeGit;
  /** GitHub reads, each run with the env `access` returns (`GH_TOKEN` set to the key teamrig saved for the owner). */
  readonly gh: GhRunner;
  /**
   * The key for one repository ('owner/name'), never the gh login. It is a `NoAccessError` when no key is
   * saved or it cannot be read (`RepoTokens.accessFor`); the source returns its message as `{ kind: 'failed' }`, naming the command that saves one.
   */
  access(repo: string): Promise<RepoAccess | NoAccessError>;
  /** The project's folder, absolute. */
  readonly project: string;
  /** The team's register, when the project has a team: the tasks its commits name. */
  readonly register: TaskReader | undefined;
}

/** The tasks of a team's register, read-only. */
export interface TaskReader {
  /** The tasks of these ids the register holds; an id it lacks is left out. */
  tasks(ids: readonly string[]): Promise<readonly RegisterTask[]>;
}

/** What a change entry takes from a task. */
export interface RegisterTask {
  readonly id: string;
  readonly title: string;
  readonly type: 'task' | 'bug';
  /** Its issue or pull request, as the register holds it ('gh:owner/name#12'); undefined when it has none. */
  readonly ref: string | undefined;
}

/** The git reads a source may make, read-only, in the project's folder. */
export interface ChangeGit {
  /** Commits in the range (a version as its tag, else a time), newest first; `paths` narrows to commits touching them. */
  log(project: string, range: { readonly since: ResolvedPoint; readonly until: ResolvedPoint | undefined; readonly paths: readonly string[] }): Promise<readonly GitCommit[]>;
  /**
   * The project's releases, newest first: its version tags ('v1.2.3', '1.2.3'), and the commits on HEAD whose subject
   * names a release ('plugin: version 0.447.0', 'chore(release): 1.2.3', 'Release v1.2.3') for a project that tags
   * none; a tag wins over a commit naming the same version. The index that resolves a version to a commit and a time.
   */
  releases(project: string): Promise<readonly Release[]>;
}

export interface Release {
  readonly version: string;
  /** ISO 8601, UTC: the commit's time. */
  readonly at: string;
  /** The commit it was made from. */
  readonly sha: string;
}

export interface GitCommit {
  readonly sha: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly string[];
}

export interface ChangeSource {
  /** Its id in config and output: 'register', 'git', 'notes', 'changesets', 'release-please', 'keep-a-changelog', 'github-releases'. */
  readonly id: string;
  readonly capabilities: ChangeSourceCapabilities;
  /** Whether it applies to this project, for `changes.sources: auto` (the default): a cheap file or folder check, never a network read. */
  detect(deps: ChangeSourceDeps): Promise<boolean>;
  read(deps: ChangeSourceDeps, query: ChangeQuery): Promise<ChangeRead>;
}
