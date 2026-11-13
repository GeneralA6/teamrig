import type { ShellWord } from '../push-guard/tokenizer.ts';

/**
 * Which `gh` calls write on an issue or pull request (T2705), read from a call's words as gh reads them. `teamrig
 * issue` checks who may write (each session only on its own, the GitHub admin on the rest, issues/ownership.ts); a
 * raw `gh` call skips that check, so the exec guard refuses it on a team whose issues are on GitHub. Opening a new
 * issue or pull request is no such write: it is the opener's own.
 */

/** The `gh issue` commands that change an existing issue. */
export const GH_ISSUE_WRITES: ReadonlySet<string> = new Set(['close', 'reopen', 'comment', 'edit', 'delete', 'lock', 'unlock', 'transfer', 'pin', 'unpin', 'develop']);

/** The `gh pr` commands that change an existing pull request. */
export const GH_PR_WRITES: ReadonlySet<string> = new Set(['close', 'reopen', 'comment', 'edit', 'merge', 'ready', 'review', 'lock', 'unlock', 'update-branch']);

/** A gh call that writes on an issue or pull request, or one whose words the guard cannot read. */
export type GhWrite = { readonly kind: 'write'; readonly what: string } | { readonly kind: 'unreadable'; readonly what: string };

/** `gh api` flags that take the next word as their value; any other flag is a switch. */
const API_VALUE_FLAGS: ReadonlySet<string> = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

/** `gh api` flags whose values make a request body, which turns gh's default GET into a POST. */
const API_BODY_FLAGS: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field', '--input']);

/** An endpoint on issues or pull requests: their comments, labels, reviews and the rest included. */
const ISSUE_PATH = /(?:^|\/)(?:issues|pulls)(?:[/?]|$)/;

/** What one flag word of a `gh api` call sets: its name, and its value when written in the same word (`-XPATCH`, `--method=PATCH`). */
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

/** True when a GraphQL call's body may hold a mutation: one names it, or comes from a file or a word only known when it runs. */
function mayMutate(body: readonly ShellWord[]): boolean {
  return body.some((value) => value.dynamic || value.text.startsWith('@') || value.text.includes('=@') || /mutation/i.test(value.text));
}

/** The write a `gh api` call makes on an issue or pull request, or undefined when it reads, or writes elsewhere. */
function apiWriteOf(words: readonly ShellWord[]): GhWrite | undefined {
  const call = apiCallOf(words);
  const endpoint = call.endpoint;
  if (endpoint === undefined) {
    return undefined;
  }
  const what = `gh api ${endpoint.text}`;
  if (!endpoint.dynamic && endpoint.text === 'graphql') {
    return call.methodUnknown || mayMutate(call.body) ? { kind: 'write', what } : undefined;
  }
  const writes = call.methodUnknown || (call.method === undefined ? call.body.length > 0 : call.method !== 'GET');
  if (!writes || !(endpoint.dynamic || ISSUE_PATH.test(endpoint.text))) {
    return undefined;
  }
  return call.methodUnknown || endpoint.dynamic ? { kind: 'unreadable', what } : { kind: 'write', what: `gh api ${call.method ?? 'POST'} ${endpoint.text}` };
}

/**
 * The write on an issue or pull request that a gh call's words (after `gh`) make, or undefined when they make none:
 * `gh issue close 7`, `gh pr merge 3`, `gh api -X PATCH repos/o/n/issues/7` and a GraphQL mutation write; `gh issue
 * create`, `gh pr view` and a GET read do not. A group or command only known when it runs is unreadable.
 */
export function ghWriteOf(words: readonly ShellWord[]): GhWrite | undefined {
  const [group, command] = words;
  if (group === undefined) {
    return undefined;
  }
  if (group.dynamic) {
    return command !== undefined && (command.dynamic || GH_ISSUE_WRITES.has(command.text) || GH_PR_WRITES.has(command.text)) ? { kind: 'unreadable', what: `gh ${group.text} ${command.text}` } : undefined;
  }
  if (group.text === 'api') {
    return apiWriteOf(words.slice(1));
  }
  const writes = group.text === 'issue' ? GH_ISSUE_WRITES : group.text === 'pr' ? GH_PR_WRITES : undefined;
  if (writes === undefined || command === undefined) {
    return undefined;
  }
  const what = `gh ${group.text} ${command.text}`;
  if (command.dynamic) {
    return { kind: 'unreadable', what };
  }
  return writes.has(command.text) ? { kind: 'write', what } : undefined;
}
