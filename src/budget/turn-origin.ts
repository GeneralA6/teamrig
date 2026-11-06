/**
 * Whether the team's own machinery started a turn, as T1995 measured it: a wake, a reopen, a refresh, a plugin's
 * message, a Stop hook or a compaction. The rollup's classes (`rollup.ts`) rest on this. It reads only the prompt's text,
 * so a push from a newer Claude Code that words itself otherwise reads as not pushed, and the coordination share can
 * only read low.
 */

/** How much of a prompt names its origin: every push says so at its start, and a long typed message must not match deep down. */
const ORIGIN_CHARS = 1_200;
const STOP_FEEDBACK = 'Stop hook feedback';
const SLASH_COMMAND = /<command-name>\/?[^<]+<\/command-name>/;
const TASK_NOTIFICATION = '<task-notification>';
const STARTED_FRESH = 'You were started fresh';
/** The words of a compaction's summary, a wake, a reopen or a plugin's message. */
const PUSH_WORDS: readonly string[] = [
  'being continued from a previous conversation',
  'The day started at',
  'The lead started',
  'Urgent lines were posted',
  'closed while idle',
  'handed to you while this tab was idle',
];
/** Words that mark a push only after the task notifications are ruled out, which can quote them. */
const LATE_PUSH_WORDS: readonly string[] = [STARTED_FRESH, 'handover', 'Stop hook', 'plugin sent a message'];

/** Whether a prompt's text is a push. A slash command or any other task notification is not, whatever it quotes. */
export function isPushedPrompt(text: string): boolean {
  const head = text.trimStart().slice(0, ORIGIN_CHARS);
  if (head.startsWith(STOP_FEEDBACK)) {
    return true;
  }
  if (SLASH_COMMAND.test(head)) {
    return false;
  }
  if (PUSH_WORDS.some((words) => head.includes(words))) {
    return true;
  }
  if (head.startsWith(TASK_NOTIFICATION)) {
    // A Stop hook's feedback now comes as a notification too, a shape newer than T1995's period.
    return head.includes(STARTED_FRESH) || head.includes(`<summary>${STOP_FEEDBACK}</summary>`);
  }
  return LATE_PUSH_WORDS.some((words) => head.includes(words));
}

/** Whether a line Claude Code marks as its own text is the Stop hook's push, the one meta line that starts a turn. */
export function isStopFeedback(text: string): boolean {
  return text.startsWith(STOP_FEEDBACK);
}
