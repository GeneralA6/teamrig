/**
 * The public interface's data: what `teamrig read` answers, built from what the commands already hold. Everything
 * here is pure: no disk, no clock, no `node:` module, so the same builders serve a reader that runs without Node
 * built-ins, and `interface/index.test.ts` fails if anything reachable from here imports one. The command
 * (src/cli/commands/read.ts) gathers through the ports and calls these.
 */
export { configBody, KEPT_NOTE, SETTING_PROBLEM, } from "./config.js";
export {} from "./connector.js";
export { answerOf, DOCUMENTS, isDocumentName, unchangedAnswer } from "./envelope.js";
export { goalsBody } from "./goals.js";
export { eventKeyOf, historyBody, } from "./history.js";
export { inboxBody } from "./inbox.js";
export { meetingsBody } from "./meetings.js";
export { planBody, } from "./plan.js";
export { refOf } from "./ref.js";
export { revisionText } from "./revision.js";
export { sessionsBody, } from "./sessions.js";
export { statsBody, } from "./stats.js";
export { sourceOf } from "./source.js";
export { tasksBody } from "./tasks.js";
export { cutText, ServedText } from "./text.js";
export { checkInterfaceRange, INTERFACE_MAJOR, INTERFACE_MINOR, INTERFACE_VERSION, parseInterfaceVersion } from "./version.js";
