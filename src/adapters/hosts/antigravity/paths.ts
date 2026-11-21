import { posix, win32 } from 'node:path';
import type { HostDeps, HostPaths } from '../../../plugin-api/index.ts';

/**
 * Antigravity's own folders and files on `platform`: `~/.gemini/config` for machine-local settings, rules and skills,
 * and `.agents/` in a project folder for shared customizations.
 */
export function hostPaths(platform: HostDeps['platform']): HostPaths {
  const path = platform === 'win32' ? win32 : posix;
  const home = (userHome: string): string => path.join(userHome, '.gemini', 'config');

  return {
    home,
    userSettings: (userHome) => path.join(home(userHome), 'config.json'),
    folderSettings: (folder) => [{ path: path.join(folder, '.agents', 'plugins.json'), kind: 'shared' }],
    worktrees: (project) => path.join(project, '.agents', 'worktrees'),
    worktreeRepo: () => undefined,
    userInstructions: (userHome) => path.join(home(userHome), 'AGENTS.md'),
    folderInstructions: (folder) => [path.join(folder, 'AGENTS.md'), path.join(folder, 'GEMINI.md')],
    userRules: (userHome) => path.join(home(userHome), 'rules'),
    projectRules: (project) => path.join(project, '.agents', 'rules'),
    skills: (userHome) => path.join(home(userHome), 'skills'),
    projectSkills: (project) => path.join(project, '.agents', 'skills'),
    userAgents: (userHome) => path.join(home(userHome), 'agents'),
    projectAgents: (project) => path.join(project, '.agents', 'agents'),
    memoryFolder: (userHome, project) => path.join(home(userHome), 'memory', path.basename(project)),
    memoryIndex: (userHome, project) => path.join(home(userHome), 'memory', path.basename(project), 'MEMORY.md'),
    memoryFolders: (userHome) => path.join(home(userHome), 'memory', '*'),
    scratchpads: (systemTemp) => path.join(systemTemp, 'antigravity', '*'),
    scratchpadOf: (transcript, systemTemp) => path.join(systemTemp, 'antigravity', path.basename(path.dirname(transcript))),
    planFile: (userHome, slug) => path.join(home(userHome), 'plans', `${slug}.md`),
    shellSnapshots: (userHome) => path.join(home(userHome), 'shell-snapshots'),
    secretFiles: () => [],
  };
}
