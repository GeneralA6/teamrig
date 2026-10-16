import { KIT_NAME } from '../core/home.ts';

/** The longest first prompt `teamrig open` passes; a longer brief belongs in a task. */
export const PROMPT_MAX = 2000;

/** The first prompt of a session opened with no `--prompt`: read the inbox, then start the first open task. */
export function defaultPrompt(team: string, id: string): string {
  return `You are the ${id} session of team ${team}. Run \`${KIT_NAME} inbox read\`, then \`${KIT_NAME} list --session ${id}\`, and start your first open task.`;
}

/**
 * The first prompt of a session the automatic restart started fresh: its handover first, so it carries on with
 * the work it left instead of the first open task, then the inbox and the task list.
 */
export function refreshPrompt(team: string, id: string, handoverPath: string): string {
  return `You are the ${id} session of team ${team}, started fresh after a context refresh. Read your handover ${handoverPath} first and carry on with its next steps, then run \`${KIT_NAME} inbox read\` and \`${KIT_NAME} list --session ${id}\`.`;
}

/** Why a prompt cannot be passed to Claude Code as its first message, or undefined when it can. */
export function promptProblem(prompt: string): string | undefined {
  if (prompt.trim() === '') {
    return 'the prompt is empty';
  }
  // Claude Code would read a leading dash as an option.
  if (prompt.startsWith('-')) {
    return 'the prompt cannot start with -';
  }
  if (prompt.length > PROMPT_MAX) {
    return `the prompt is over ${PROMPT_MAX} characters; put the brief in a task instead`;
  }
  if (prompt.includes('\0')) {
    return 'the prompt contains a NUL character';
  }
  return undefined;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * The prompt as base64url, so it crosses a terminal launcher's command line (Windows Terminal splits on
 * `;`, AppleScript and shells have quotes) as letters, digits, `-` and `_` only.
 */
export function encodePrompt(prompt: string): string {
  return Buffer.from(prompt, 'utf8').toString('base64url');
}

/** The prompt back from `encodePrompt`, or undefined for text it did not make. */
export function decodePrompt(encoded: string): string | undefined {
  if (!BASE64URL.test(encoded)) {
    return undefined;
  }
  const prompt = Buffer.from(encoded, 'base64url').toString('utf8');
  // Buffer skips what it cannot decode; only an exact round trip proves the text was whole.
  return encodePrompt(prompt) === encoded ? prompt : undefined;
}
