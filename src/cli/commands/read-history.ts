import { SecretScanner } from '../../core/secrets.ts';
import { historyBody, type Connector } from '../../interface/index.ts';
import { layoutPaths } from '../../register/layout.ts';
import { UsageError } from '../args.ts';
import { stampsOf, taskEventsOf, type DocumentSource, type ReadScope } from './read-source.ts';

/**
 * `history`: every event the team's register holds of the one task `--task` names, in the order they were written.
 * It reads what `tasks` reads (the config for the owner's marker, the secret shapes and the sessions, the renames,
 * the snapshot and the events after it) and, for a task whose events the working set no longer holds, the archive's
 * segments. An id the register holds no event of answers no event and is not refused, since a run answers every
 * document it was asked or none; a task that moved to another team ends at its move, as that team's register is
 * read only by a run that names it. `--owner` does not narrow it: the task is named.
 */
export function historySource(connectors: readonly Connector[]): (scope: ReadScope) => DocumentSource {
  return (scope) => {
    const { runtime, kit, config, roster, task } = scope;
    if (task === null) {
      throw new UsageError('history is one task\'s: name it with --task T<id>');
    }
    const layout = layoutPaths(kit.paths.events);
    return {
      async parts() {
        return {
          document: 'history',
          args: [
            ['team', kit.paths.team],
            ['task', task],
          ],
          stamps: [
            ...(await stampsOf(runtime, [kit.load.path, kit.paths.renames, layout.snapshot, layout.tail])),
            // A segment is written once and counts by name, as in `tasks`: one that went missing and came back changes the answer.
            (await runtime.files.list(layout.archive)).join(','),
          ],
        };
      },
      async build() {
        const read = await taskEventsOf(runtime, kit.paths, layout, task);
        const body = historyBody({
          task,
          events: read.events,
          shapes: new SecretScanner(config.register.secretPatterns),
          connectors,
          names: { owner: config.register.ownerSource, connectors, nameOf: (session) => roster.nameOf(session) },
        });
        return { body, problems: read.problems };
      },
    };
  };
}
