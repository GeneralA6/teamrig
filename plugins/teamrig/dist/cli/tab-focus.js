import { ENV } from "../core/home.js";
import { MeetingStore, phaseOf } from "../meeting/state.js";
import { loadTree } from "./tree.js";
/**
 * Whether a tab a command opens takes the focus (T2510): only when the human typed the command, which Claude Code's
 * CLAUDECODE in the environment rules out (an agent's tool call, a hook, a script one runs), and no team of the kit home
 * has its meeting open, so a tab opened then never pulls the owner out of the meeting.
 */
export async function tabFocusOf(runtime) {
    const claudeCode = runtime.env[ENV.claudeCode];
    if (claudeCode !== undefined && claudeCode !== '') {
        return 'keep';
    }
    const { teams } = await loadTree(runtime);
    const now = runtime.clock.now();
    for (const { kit } of teams.values()) {
        if (phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), now).kind === 'open') {
            return 'keep';
        }
    }
    return 'take';
}
