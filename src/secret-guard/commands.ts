import type { ProgramRun } from '../package-guard/programs.ts';
import type { SecretFinding } from './findings.ts';
import type { PatternList } from './pattern-list.ts';

/**
 * The commands whose output is a secret whatever file or variable they name, as regular expressions over a run's line
 * (`<program> <args>`, the program as the guards compare it), case ignored: `kubectl config view --raw` prints the
 * cluster credentials a plain `view` redacts. A team's own patterns come after these, and the last that matches decides:
 * `!pattern` lets a line print.
 */
export const DEFAULT_SECRET_COMMANDS: readonly string[] = ['^kubectl(?=\\s)(?=.*\\sconfig\\s+view(?:\\s|$))(?=.*\\s--raw(?:=true)?(?:\\s|$))'];

/** The dump command a run that prints is, by its program alone: its line may hold a literal, so it is never quoted. */
export function commandFindings(run: ProgramRun, commands: PatternList): SecretFinding[] {
  return commands.matches([run.name, ...run.args.map((arg) => arg.text)].join(' ')) ? [{ kind: 'command', program: run.name }] : [];
}
