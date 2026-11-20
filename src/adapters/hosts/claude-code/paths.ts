import { basename, dirname, join } from 'node:path';
import type { HostDeps, HostPaths } from '../../../plugin-api/index.ts';

/** Moves Claude Code's own folder (settings, plugins, transcripts) away from `~/.claude`. */
const CONFIG_DIR = 'CLAUDE_CONFIG_DIR';
/** Moves Claude Code's temporary files, session scratchpads among them, away from the system's temporary folder. */
const TEMP_DIR = 'CLAUDE_CODE_TMPDIR';

/** The variable's value, or undefined when it is unset or blank: a blank one moves nothing. */
function setIn(env: HostDeps['env'], name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Where Claude Code keeps its files, in the environment of one run. */
export function hostPaths(env: HostDeps['env']): HostPaths {
  const home = (userHome: string): string => setIn(env, CONFIG_DIR) ?? join(userHome, '.claude');
  /** Its temporary files: a session's scratchpad is `<it>/<project folder>/<session>/scratchpad`. */
  const temp = (systemTemp: string): string => join(setIn(env, TEMP_DIR) ?? systemTemp, 'claude');
  return {
    home,
    skills: (userHome) => join(home(userHome), 'skills'),
    memoryFolders: (userHome) => join(home(userHome), 'projects', '*', 'memory'),
    scratchpads: (systemTemp) => join(temp(systemTemp), '*', '*', 'scratchpad'),
    // A transcript is `<project folder>/<session>.jsonl`, and the scratchpad keeps both names.
    scratchpadOf: (transcript, systemTemp) => join(temp(systemTemp), basename(dirname(transcript)), basename(transcript, '.jsonl'), 'scratchpad'),
    planFile: (userHome, slug) => join(home(userHome), 'plans', `${slug}.md`),
    shellSnapshots: (userHome) => join(home(userHome), 'shell-snapshots'),
  };
}
