import type { CoordinatorRepoConfig } from '../config/types.ts';

/** What a deploy of `repo` disturbs: what a push to its default branch deploys and what its roll rolls, each once. */
export function repoTargetsOf(repo: CoordinatorRepoConfig): string[] {
  return [...new Set([...repo.deploysOnPush, ...(repo.deploy?.targets ?? [])])];
}

/** Every target a claim, a load or a window may name: what the team's repositories deploy on push and what their rolls roll, each once. */
export function deployTargetsOf(repos: Readonly<Record<string, CoordinatorRepoConfig>>): string[] {
  return [...new Set(Object.values(repos).flatMap(repoTargetsOf))];
}
