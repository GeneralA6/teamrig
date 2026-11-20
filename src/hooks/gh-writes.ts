import { githubRepoOf } from '../github/pull-conflicts.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';

/**
 * What a raw `gh` call does, read from its words as gh reads them (T3002, T4819). gh writes with the login its
 * keyring holds, not the key the team saved for its repositories, and past teamrig's check of who may write, so the
 * exec guard lets only reads through on the team's own repositories (`github.repos`, hooks/gh-write-refusals.ts). A read is a
 * command on an allowlist (view, list, status, diff, checks, search, a checkout, clone or download, a `gh api` GET with
 * no body, a GraphQL query); everything else is a write, placed on the repositories it reaches as far as its words
 * tell, else unplaced, which the guard refuses on such a team.
 */

/** Where a write lands: the repositories its words name (`owner/name`, lowercase), and whether gh also picks one from the folder it runs in or `GH_REPO`. */
export interface GhTarget {
  readonly repos: readonly string[];
  readonly folder: boolean;
}

/** A gh call: a read; a write and where it lands; or a write the guard cannot place on a repository, and why. */
export type GhCall =
  | { readonly kind: 'read' }
  | { readonly kind: 'write'; readonly what: string; readonly target: GhTarget }
  | { readonly kind: 'unplaced'; readonly what: string; readonly why: string };

const setOf = (...words: string[]): ReadonlySet<string> => new Set(words);

/** The commands of each group that only read GitHub; a checkout, clone or download writes only on this machine. */
export const GH_READS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['issue', setOf('list', 'view', 'status')],
  ['pr', setOf('list', 'view', 'status', 'diff', 'checks', 'checkout')],
  ['repo', setOf('list', 'view', 'clone')],
  ['release', setOf('list', 'view', 'download')],
  ['run', setOf('list', 'view', 'watch', 'download')],
  ['workflow', setOf('list', 'view')],
  ['label', setOf('list')],
  ['cache', setOf('list')],
  ['ruleset', setOf('list', 'view', 'check')],
  ['secret', setOf('list')],
  ['variable', setOf('list', 'get')],
  ['gist', setOf('list', 'view')],
  ['org', setOf('list')],
  ['project', setOf('list', 'view', 'field-list', 'item-list')],
  ['codespace', setOf('list', 'view')],
  ['auth', setOf('status')],
  ['config', setOf('get', 'list')],
  ['alias', setOf('list')],
  ['extension', setOf('list', 'search')],
  ['ssh-key', setOf('list')],
  ['gpg-key', setOf('list')],
]);

/** The groups every command of which only reads: `co` is gh's own name for `pr checkout`. */
const READ_GROUPS: ReadonlySet<string> = setOf('search', 'status', 'browse', 'attestation', 'completion', 'help', 'version', 'co');

/** The groups whose commands act on one repository: `-R`, else the folder's repository or `GH_REPO`. */
const REPO_GROUPS: ReadonlySet<string> = setOf('issue', 'pr', 'repo', 'release', 'run', 'workflow', 'label', 'cache', 'ruleset', 'secret', 'variable');

/** The groups that can act on an organization or user, not a repository, when one of `ORG_FLAGS` says so. */
const ORG_GROUPS: ReadonlySet<string> = setOf('secret', 'variable', 'ruleset');
const ORG_FLAGS: ReadonlySet<string> = setOf('--org', '-o', '--user', '-u');

/** The groups that write on the account, outside any one repository. */
const ACCOUNT_GROUPS: ReadonlySet<string> = setOf('gist', 'org', 'project', 'codespace', 'ssh-key', 'gpg-key');

/** The groups that change gh's own login, settings, aliases or extensions. */
const LOCAL_GROUPS: ReadonlySet<string> = setOf('auth', 'config', 'alias', 'extension');

/** Every group gh has: a word naming none of them is an alias or an extension. */
const GH_GROUPS: ReadonlySet<string> = new Set(['api', ...GH_READS.keys(), ...READ_GROUPS]);

/** `gh api` flags that take the next word as their value; any other flag is a switch. */
const API_VALUE_FLAGS: ReadonlySet<string> = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

/** `gh api` flags whose values make a request body, which turns gh's default GET into a POST. */
const API_BODY_FLAGS: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field', '--input']);

/**
 * The path a `gh api` endpoint reaches, as the checks read it. gh takes `graphql`, a path with or without a leading
 * slash, or a full URL, and a URL ending in `graphql` gets a GraphQL request whatever its spelling (T2705):
 * so the scheme and host, the query and slashes at either end are dropped, and the case.
 */
export function endpointPath(text: string): string {
  return text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu, '')
    .replace(/[?#].*$/su, '')
    .replace(/^\/+|\/+$/gu, '')
    .toLowerCase();
}

/** True for a GraphQL endpoint path: `graphql` itself, or one that ends in it, such as an Enterprise host's `api/graphql`. */
function isGraphqlPath(path: string): boolean {
  return path === 'graphql' || path.endsWith('/graphql');
}

/** What one flag word sets: its name, and its value when written in the same word (`-XPATCH`, `--method=PATCH`). */
function flagOf(text: string): { readonly name: string; readonly value: string | undefined } {
  if (text.startsWith('--')) {
    const equals = text.indexOf('=');
    return equals === -1 ? { name: text, value: undefined } : { name: text.slice(0, equals), value: text.slice(equals + 1) };
  }
  return text.length > 2 ? { name: text.slice(0, 2), value: text.slice(2) } : { name: text, value: undefined };
}

/** The words of a `gh api` call, as gh reads them. */
interface ApiCall {
  readonly endpoint: ShellWord | undefined;
  /** The method `-X` names, upper-cased; undefined when it names none. */
  readonly method: string | undefined;
  /** True when a `-X` has no value to name the method. */
  readonly methodUnknown: boolean;
  /** The request body's values: every field, and `@file` for `--input`. */
  readonly body: readonly string[];
}

/** Reads a `gh api` call's words after `api`, all known before it runs. */
function apiCallOf(words: readonly ShellWord[]): ApiCall {
  let endpoint: ShellWord | undefined;
  let method: string | undefined;
  let methodUnknown = false;
  const body: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) {
      break;
    }
    if (!word.text.startsWith('-')) {
      endpoint ??= word;
      continue;
    }
    const flag = flagOf(word.text);
    if (!API_VALUE_FLAGS.has(flag.name)) {
      continue;
    }
    const value = flag.value ?? words[index + 1]?.text;
    index += flag.value === undefined ? 1 : 0;
    if (flag.name === '-X' || flag.name === '--method') {
      methodUnknown = value === undefined;
      method = value?.toUpperCase();
    } else if (API_BODY_FLAGS.has(flag.name) && value !== undefined) {
      body.push(flag.name === '--input' ? `@${value}` : value);
    }
  }
  return { endpoint, method, methodUnknown, body };
}

/** The endpoint a `gh api` call's words (after `api`) name, or undefined when they name none. */
export function apiEndpointOf(words: readonly ShellWord[]): ShellWord | undefined {
  return apiCallOf(words).endpoint;
}

/** True when a GraphQL call's body may hold a mutation: one names it, or comes from a file. */
function mayMutate(body: readonly string[]): boolean {
  return body.some((value) => value.startsWith('@') || value.includes('=@') || /mutation/i.test(value));
}

/** gh's placeholders for the owner and the name of the folder's repository (or `GH_REPO`), in both its spellings. */
const FOLDER_OWNER: ReadonlySet<string> = setOf('{owner}', ':owner');
const FOLDER_NAME: ReadonlySet<string> = setOf('{repo}', ':repo');

/**
 * The repository a `repos/<owner>/<name>/...` endpoint path names; `folder` for gh's `{owner}/{repo}` or
 * `:owner/:repo`, which it fills from the folder or `GH_REPO`; undefined for any other path, or a part shaped like a
 * placeholder, which no GitHub owner or name can hold.
 */
function apiRepoOf(path: string): string | 'folder' | undefined {
  const [first, owner, name] = path.split('/');
  if (first !== 'repos' || owner === undefined || name === undefined || owner === '' || name === '') {
    return undefined;
  }
  if (FOLDER_OWNER.has(owner) && FOLDER_NAME.has(name)) {
    return 'folder';
  }
  return /[{}:]/u.test(owner) || /[{}:]/u.test(name) ? undefined : `${owner}/${name}`;
}

/** True when a path has a `.` or `..` segment, or a `%`-escape, which GitHub's front end may resolve to another path. */
function mayResolveElsewhere(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..' || segment.includes('%'));
}

/**
 * A `gh api` call: a read when it is a GET with no body or a GraphQL query, else a write placed by its endpoint. A
 * word only known when it runs may be a flag that sets the method (`"$M"` holding `-XPUT`), or split into several
 * that move the endpoint, so it makes the call unplaced, a read too.
 */
function apiCallKind(words: readonly ShellWord[]): GhCall {
  const call = apiCallOf(words);
  const endpoint = call.endpoint;
  if (words.some((word) => word.dynamic)) {
    return { kind: 'unplaced', what: endpoint === undefined ? 'gh api' : `gh api ${endpoint.text}`, why: 'a word only known when it runs may set its method or its endpoint' };
  }
  if (endpoint === undefined) {
    return { kind: 'read' };
  }
  const path = endpointPath(endpoint.text);
  if (isGraphqlPath(path)) {
    return call.methodUnknown || mayMutate(call.body) ? { kind: 'unplaced', what: `gh api ${endpoint.text}`, why: 'a GraphQL mutation can reach any repository the login reaches' } : { kind: 'read' };
  }
  const writes = call.methodUnknown || (call.method === undefined ? call.body.length > 0 : call.method !== 'GET');
  if (!writes) {
    return { kind: 'read' };
  }
  const what = call.methodUnknown ? `gh api ${endpoint.text}` : `gh api ${call.method ?? 'POST'} ${endpoint.text}`;
  if (mayResolveElsewhere(path)) {
    return { kind: 'unplaced', what, why: 'its endpoint has a `.`, `..` or `%` segment, which may reach another path' };
  }
  const repo = apiRepoOf(path);
  if (repo === undefined) {
    return { kind: 'unplaced', what, why: 'its endpoint is no `repos/<owner>/<name>` path, so it writes outside any one repository' };
  }
  return { kind: 'write', what, target: repo === 'folder' ? { repos: [], folder: true } : { repos: [repo], folder: false } };
}

/** `owner/name`, lowercase, without `.git`, from the parts of a path; undefined when the parts are no repository. */
function repoFromParts(owner: string | undefined, name: string | undefined): string | undefined {
  const part = /^[\w.-]+$/u;
  if (owner === undefined || name === undefined || !part.test(owner) || !part.test(name)) {
    return undefined;
  }
  return `${owner}/${name.replace(/\.git$/iu, '')}`.toLowerCase();
}

/** The repository a `-R`/`--repo` value names: `OWNER/REPO`, `HOST/OWNER/REPO` or a URL; undefined when it names none. */
export function repoFlagValue(text: string): string | undefined {
  const parts = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/iu, '')
    .split('/')
    .filter((part) => part !== '');
  if (parts.length === 2) {
    return repoFromParts(parts[0], parts[1]);
  }
  return parts.length === 3 ? repoFromParts(parts[1], parts[2]) : undefined;
}

/**
 * The repository a word may name, as gh takes it in place of a number or a name: a URL (`https://github.com/o/n/pull/3`),
 * `o/n` or `o/n#3`. A word naming none, such as a file path with more parts, gives undefined; one that only looks like
 * a repository adds a name the guard checks too, which can only refuse more.
 */
export function repoInWord(text: string): string | undefined {
  const url = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s#?]+)/iu.exec(text);
  if (url !== null) {
    return repoFromParts(url[1], url[2]);
  }
  const named = /^([\w.-]+)\/([\w.-]+)(?:#\d+)?$/u.exec(text);
  return named === null ? undefined : repoFromParts(named[1], named[2]);
}

/** The repositories a write's words name through `-R`/`--repo`; undefined when a value names none. */
function repoFlagsOf(words: readonly ShellWord[]): { readonly repos: string[]; readonly given: boolean } | undefined {
  const repos: string[] = [];
  let given = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const flag = word === undefined ? undefined : flagOf(word.text);
    if (flag === undefined || (flag.name !== '-R' && flag.name !== '--repo')) {
      continue;
    }
    const text = flag.value ?? words[index + 1]?.text;
    index += flag.value === undefined ? 1 : 0;
    const repo = text === undefined ? undefined : repoFlagValue(text);
    if (repo === undefined) {
      return undefined;
    }
    repos.push(repo);
    given = true;
  }
  return { repos, given };
}

/** A write of a group that acts on one repository, placed by its words. */
function repoWriteOf(group: string, what: string, words: readonly ShellWord[]): GhCall {
  if (words.some((word) => word.dynamic)) {
    return { kind: 'unplaced', what, why: 'a word only known when it runs may name another repository' };
  }
  if (ORG_GROUPS.has(group) && words.some((word) => ORG_FLAGS.has(flagOf(word.text).name))) {
    return { kind: 'unplaced', what, why: 'it writes on an organization or user, outside any one repository' };
  }
  const flags = repoFlagsOf(words);
  if (flags === undefined) {
    return { kind: 'unplaced', what, why: 'its `-R` value names no repository' };
  }
  const named = words.flatMap((word) => {
    const repo = word.text.startsWith('-') ? undefined : repoInWord(word.text);
    return repo === undefined ? [] : [repo];
  });
  return { kind: 'write', what, target: { repos: [...new Set([...flags.repos, ...named])], folder: !flags.given } };
}

/** A group's command, found past the flags gh takes before it; or why the guard cannot tell which command it is. */
export type GhCommandSlot =
  /** `rest` is the group's other words, the flags before the command among them. */
  | { readonly kind: 'command'; readonly command: ShellWord | undefined; readonly rest: readonly ShellWord[] }
  /** A help flag before the command: gh prints its help and runs nothing. */
  | { readonly kind: 'help' }
  | { readonly kind: 'unread'; readonly why: string };

/**
 * A group's command from its words after the group. gh takes `-R`/`--repo` before the command as well as after it
 * (`gh pr --repo=o/n merge 5`), so the command is the first word past them; any other flag there, or a word only known
 * when it runs, which may split into a command and more, leaves the command unread.
 */
export function ghCommandSlotOf(afterGroup: readonly ShellWord[]): GhCommandSlot {
  let index = 0;
  for (let word = afterGroup[index]; word?.text.startsWith('-') === true; word = afterGroup[index]) {
    const flag = flagOf(word.text);
    if (flag.name === '-h' || flag.name === '--help') {
      return { kind: 'help' };
    }
    if (flag.name !== '-R' && flag.name !== '--repo') {
      return { kind: 'unread', why: `\`${word.text}\` before its command may hide which command it is` };
    }
    index += flag.value === undefined ? 2 : 1;
  }
  const before = afterGroup.slice(0, index);
  if (before.some((word) => word.dynamic)) {
    return { kind: 'unread', why: 'a word only known when it runs, before its command, may change which command it is' };
  }
  return { kind: 'command', command: afterGroup[index], rest: [...before, ...afterGroup.slice(index + 1)] };
}

/**
 * What a gh call's words (after `gh`) do: `gh pr view 3`, `gh api repos/o/n/pulls` and a GraphQL query read; `gh issue
 * close 7 -R o/n` writes on o/n, `gh pr create` on the folder's repository; `gh gist create`, a GraphQL mutation and an
 * alias or extension are unplaced. A word only known when it runs makes a write unplaced, and a group only known when
 * it runs any call, since it may split into a group and a write (`$G list` with `G='issue close 5 -c'`).
 */
export function ghCallOf(words: readonly ShellWord[]): GhCall {
  const [group] = words;
  if (group === undefined) {
    return { kind: 'read' };
  }
  if (group.dynamic) {
    return { kind: 'unplaced', what: `gh ${group.text}`, why: 'its group is only known when it runs' };
  }
  if (group.text.startsWith('-')) {
    return group.text === '--version' || group.text === '--help' || group.text === '-h' ? { kind: 'read' } : { kind: 'unplaced', what: `gh ${words.slice(0, 2).map((word) => word.text).join(' ')}`, why: 'gh takes no flag before its command' };
  }
  if (group.text === 'api') {
    return apiCallKind(words.slice(1));
  }
  if (READ_GROUPS.has(group.text)) {
    return { kind: 'read' };
  }
  if (!GH_GROUPS.has(group.text)) {
    return { kind: 'unplaced', what: `gh ${group.text}`, why: 'gh runs it as an alias or an extension, which the guard cannot read' };
  }
  const slot = ghCommandSlotOf(words.slice(1));
  if (slot.kind === 'help') {
    return { kind: 'read' };
  }
  if (slot.kind === 'unread') {
    return { kind: 'unplaced', what: `gh ${group.text}`, why: slot.why };
  }
  const { command, rest } = slot;
  if (command === undefined) {
    return { kind: 'read' };
  }
  const what = `gh ${group.text} ${command.text}`;
  if (command.dynamic) {
    return { kind: 'unplaced', what, why: 'its command is only known when it runs' };
  }
  if (GH_READS.get(group.text)?.has(command.text) === true) {
    return { kind: 'read' };
  }
  if (REPO_GROUPS.has(group.text)) {
    return repoWriteOf(group.text, what, rest);
  }
  if (ACCOUNT_GROUPS.has(group.text)) {
    return { kind: 'unplaced', what, why: 'it writes on the GitHub account, outside any one repository' };
  }
  return { kind: 'unplaced', what, why: LOCAL_GROUPS.has(group.text) ? "it changes gh's own login, settings, aliases or extensions" : 'the guard knows no repository it writes on' };
}

/** True when an unnamed program's words may be a gh call: their first word names a gh group. A group only known when it runs too would read every `$PROGRAM $SCRIPT` line as one. */
export function mayBeGhCall(words: readonly ShellWord[]): boolean {
  const [group] = words;
  return group !== undefined && !group.dynamic && GH_GROUPS.has(group.text);
}

/** The host a remote URL reaches: `scheme://[user@]host`, else scp-like `[user@]host:path`; '' for a folder on this machine. */
function remoteHostOf(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]*)/iu.exec(url);
  if (withScheme !== null) {
    return (withScheme[1] ?? '').toLowerCase();
  }
  const scpLike = /^[a-z]:[\\/]/iu.test(url) ? null : /^(?:[^@/]*@)?([^/:]+):/u.exec(url);
  return (scpLike?.[1] ?? '').toLowerCase();
}

/**
 * True when a remote URL plainly reaches no GitHub host: a folder on this machine, or a host with a dot and no
 * `github` in it. A host with no dot may be an SSH alias (`git@work-gh:o/n.git`), which gh resolves to github.com,
 * and a remote helper (`ext::<command>`) may run anything.
 */
function plainlyOffGithub(url: string): boolean {
  if (url.includes('::')) {
    return false;
  }
  const host = remoteHostOf(url);
  return host === '' || (host.includes('.') && !host.includes('github'));
}

/**
 * The GitHub repositories (`owner/name`, lowercase) a `git remote -v` listing names; undefined when a remote names
 * none the guard can read yet may reach GitHub, such as through an SSH host alias or a port, so a write there fails
 * closed. A remote plainly off GitHub names none.
 */
export function remoteReposOf(listing: string): string[] | undefined {
  const repos = new Set<string>();
  for (const line of listing.split(/\r?\n/u)) {
    const url = line.split(/\s+/u)[1];
    if (url === undefined || url === '') {
      continue;
    }
    const repo = githubRepoOf(url);
    if (repo !== undefined) {
      repos.add(repo);
    } else if (!plainlyOffGithub(url)) {
      return undefined;
    }
  }
  return [...repos];
}
