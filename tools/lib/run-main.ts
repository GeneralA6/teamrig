import { EXIT_USAGE } from './exit.ts';

/**
 * Runs a repo tool's `main` and returns its exit code. When `main` throws (an unknown option, a
 * failed git command, an unreadable file), prints `<name>: <message>` through `report` and returns EXIT_USAGE.
 */
export async function runMain(name: string, main: () => Promise<number>, report: (line: string) => void): Promise<number> {
  try {
    return await main();
  } catch (error) {
    report(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }
}
