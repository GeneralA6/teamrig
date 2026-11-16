import { readSubject, shortSha } from '../subject.ts';
import type { ChangeEntry, ChangeSource } from '../source.ts';
import { pathsOf, readFailure } from './shared.ts';

/**
 * Commit subjects in the range: the fallback for a project that keeps nothing else. A Conventional Commits prefix
 * sets the kind (`feat` a feature, `fix` a fix, `!` or a `BREAKING CHANGE:` line a behaviour change) and its scope
 * the area; any other `area: text` prefix is the area. Release commits and build, test and tooling ones are left
 * out: no user of the project reads them.
 */
export const GIT_SOURCE: ChangeSource = {
  id: 'git',
  capabilities: { byVersion: true, byDate: true, byFile: true, byArea: false, classified: false },
  detect: async ({ files, project }) => (await files.list(project)).includes('.git'),
  read: async ({ git, project }, query) => {
    try {
      const commits = await git.log(project, { since: query.since, until: query.until, paths: pathsOf(query) });
      const entries = commits.flatMap((commit): ChangeEntry[] => {
        const read = readSubject(commit.subject, commit.body);
        return read.hidden
          ? []
          : [
              {
                source: 'git',
                version: undefined,
                at: commit.at,
                area: read.area,
                kind: read.kind,
                audience: 'lead',
                text: read.text,
                action: undefined,
                files: commit.files,
                refs: [shortSha(commit.sha), ...read.taskIds, ...read.numbers],
              },
            ];
      });
      return { kind: 'read', entries, warnings: [] };
    } catch (error) {
      return readFailure(error);
    }
  },
};
