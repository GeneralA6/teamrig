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

/** The commands that read in any group, for a group only known when it runs. */
const READ_IN_ANY_GROUP: ReadonlySet<string> = setOf('list', 'view', 'status', 'diff', 'checks');

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
  /** True when a word only known when it runs may name the method or change it. */
  readonly methodUnknown: boolean;
  /** The request body's values: every field, and `@file` for `--input`. */
  readonly body: readonly ShellWord[];
}

/** Reads a `gh api` call's words after `api`. */
function apiCallOf(words: readonly ShellWord[]): ApiCall {
  let endpoint: ShellWord | undefined;
  let method: string | undefined;
  let methodUnknown = false;
  const body: ShellWord[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) {
      break;
    }
    if (!word.text.startsWith('-')) {
      if (endpoint === undefined) {
        endpoint = word;
      } else {
        methodUnknown ||= word.dynamic;
      }
      continue;
    }
    const flag = flagOf(word.text);
    if (!API_VALUE_FLAGS.has(flag.name)) {
      methodUnknown ||= word.dynamic;
      continue;
    }
    const value: ShellWord | undefined = flag.value === undefined ? words[index + 1] : { text: flag.value, dynamic: word.dynamic };
    index += flag.value === undefined ? 1 : 0;
    if (flag.name === '-X' || flag.name === '--method') {
      methodUnknown ||= value === undefined || value.dynamic;
      method = value?.text.toUpperCase();
    } else if (API_BODY_FLAGS.has(flag.name) && value !== undefined) {
      body.push(flag.name === '--input' ? { text: `@${value.text}`, dynamic: value.dynamic } : value);
    }
  }
  return { endpoint, method, methodUnknown, body };
}

/** The endpoint a `gh api` call's words (after `api`) name, or undefined when they name none. */
export function apiEndpointOf(words: readonly ShellWord[]): ShellWord | undefined {
  return apiCallOf(words).endpoint;
}

/** True when a GraphQL call's body may hold a mutation: one names it, or comes from a file or a word only known when it runs. */
function mayMutate(body: readonly ShellWord[]): boolean {
  return body.some((value) => value.dynamic || value.text.startsWith('@') || value.text.includes('=@') || /mutation/i.test(value.text));
}

/** The repository a `repos/<owner>/<name>/...` endpoint path names; `folder` for gh's `{owner}/{repo}`, which it fills from the folder or `GH_REPO`. */
function apiRepoOf(path: string): string | 'folder' | undefined {
  const [first, owner, name] = path.split('/');
  if (first !== 'repos' || owner === undefined || name === undefined || owner === '' || name === '') {
    return undefined;
  }
  if (owner === '{owner}' && name === '{repo}') {
    return 'folder';
  }
  return owner.includes('{') || name.includes('{') ? undefined : `${owner}/${name}`;
}

/** A `gh api` call: a read when it is a GET with no body or a GraphQL query, else a write placed by its endpoint. */
function apiCallKind(words: readonly ShellWord[]): GhCall {
  const call = apiCallOf(words);
  const endpoint = call.endpoint;
  if (endpoint === undefined) {
    return { kind: 'read' };
  }
  const path = endpoint.dynamic ? undefined : endpointPath(endpoint.text);
  if (path !== undefined && isGraphqlPath(path)) {
    return call.methodUnknown || mayMutate(call.body) ? { kind: 'unplaced', what: `gh api ${endpoint.text}`, why: 'a GraphQL mutation can reach any repository the login reaches' } : { kind: 'read' };
  }
  const writes = call.methodUnknown || (call.method === undefined ? call.body.length > 0 : call.method !== 'GET');
  if (!writes) {
    return { kind: 'read' };
  }
  const what = call.methodUnknown ? `gh api ${endpoint.text}` : `gh api ${call.method ?? 'POST'} ${endpoint.text}`;
  if (path === undefined) {
    return { kind: 'unplaced', what, why: 'its endpoint is only known when it runs' };
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

/**
 * What a gh call's words (after `gh`) do: `gh pr view 3`, `gh api repos/o/n/pulls` and a GraphQL query read; `gh issue
 * close 7 -R o/n` writes on o/n, `gh pr create` on the folder's repository; `gh gist create`, a GraphQL mutation and an
 * alias or extension are unplaced. A word only known when it runs makes a write unplaced, or a group only known when
 * it runs reads only with a command every group reads with.
 */
export function ghCallOf(words: readonly ShellWord[]): GhCall {
  const [group, command] = words;
  if (group === undefined) {
    return { kind: 'read' };
  }
  const what = `gh ${words
    .slice(0, 2)
    .map((word) => word.text)
    .join(' ')}`;
  if (group.dynamic) {
    return command !== undefined && !command.dynamic && READ_IN_ANY_GROUP.has(command.text) ? { kind: 'read' } : { kind: 'unplaced', what, why: 'its command is only known when it runs' };
  }
  if (group.text.startsWith('-')) {
    return group.text === '--version' || group.text === '--help' || group.text === '-h' ? { kind: 'read' } : { kind: 'unplaced', what, why: 'gh takes no flag before its command' };
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
  if (command === undefined) {
    return { kind: 'read' };
  }
  if (command.dynamic) {
    return { kind: 'unplaced', what, why: 'its command is only known when it runs' };
  }
  if (GH_READS.get(group.text)?.has(command.text) === true) {
    return { kind: 'read' };
  }
  if (REPO_GROUPS.has(group.text)) {
    return repoWriteOf(group.text, what, words.slice(2));
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

/** The GitHub repositories (`owner/name`, lowercase) a `git remote -v` listing names; a remote off github.com names none. */
export function remoteReposOf(listing: string): string[] {
  const repos = listing.split(/\r?\n/u).flatMap((line) => {
    const url = line.split(/\s+/u)[1];
    const repo = url === undefined ? undefined : githubRepoOf(url);
    return repo === undefined ? [] : [repo];
  });
  return [...new Set(repos)];
}
