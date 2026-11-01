import type { ProgramResult } from '../github/credentials.ts';

/** The output of a PowerShell run that exited 0; any other end throws with the first line it printed. */
export function powerShellOutput(result: ProgramResult): string {
  if (result.end.kind === 'exited' && result.end.code === 0) {
    return result.stdout;
  }
  const said = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? 'no error text';
  const end = result.end.kind === 'exited' ? `exit ${result.end.code}` : `signal ${result.end.signal}`;
  throw new Error(`PowerShell ended with ${end}: ${said}`);
}
