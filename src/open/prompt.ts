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

/**
 * The first prompt of a rehired session opened fresh: the handover its last run left at its retire first, so it
 * knows what it did and where that lives, then the inbox and the task list.
 */
export function rehirePrompt(team: string, id: string, handoverPath: string): string {
  return `You are the ${id} session of team ${team}, hired back after a retire. Read the handover your last run left, ${handoverPath}, first, then run \`${KIT_NAME} inbox read\` and \`${KIT_NAME} list --session ${id}\`, and start your first open task.`;
}

/** The first prompt of a session `teamrig close` ended, resumed in its last Claude Code session: its tasks may have moved. */
export function reopenPrompt(team: string, id: string): string {
  return `You are the ${id} session of team ${team}, closed while idle to free the host and resumed in your last Claude Code session. Your tasks may have moved since: run \`${KIT_NAME} inbox read\` and \`${KIT_NAME} list --session ${id}\`, and start your first open task.`;
}

/** The first prompt of a rehired session resumed in its last Claude Code session: it knows its work, but its tasks may have moved. */
export function resumePrompt(team: string, id: string): string {
  return `You are the ${id} session of team ${team}, hired back after a retire and resumed in your last Claude Code session. Your tasks may have moved since: run \`${KIT_NAME} inbox read\` and \`${KIT_NAME} list --session ${id}\`, and start your first open task.`;
}

/**
 * The first prompt of a session that ended outside teamrig (a crash, a reboot, a lost tab), neither closed nor
 * rehired, resumed in its last Claude Code session with `open --resume` (T1743): it knows its work, but its tasks may
 * have moved.
 */
export function recoverPrompt(team: string, id: string): string {
  return `You are the ${id} session of team ${team}, resumed in your last Claude Code session after its tab ended. Your tasks may have moved since: run \`${KIT_NAME} inbox read\` and \`${KIT_NAME} list --session ${id}\`, and carry on with your work.`;
}

/**
 * What a session hears when the owner meets it on its own cards waiting on them (`teamrig meet`, T1295): the line
 * that wakes a running session, and the first prompt's ask of one opened for the meeting.
 */
export function meetAsk(id: string, ownerMarker: string): string {
  return `${ownerMarker} meets you now on your cards waiting on them: run \`${KIT_NAME} meet --cards --session ${id}\` and follow what it prints.`;
}

/** The first prompt of a session opened fresh for the owner's meeting on its cards: only the meeting, so its context stays small. */
export function meetPrompt(team: string, id: string, ownerMarker: string): string {
  return `You are the ${id} session of team ${team}. ${meetAsk(id, ownerMarker)}`;
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
