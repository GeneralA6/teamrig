import type { CheckoutProbe } from './binding.ts';
import type { ExecSpawner } from './runner.ts';

/**
 * What `teamrig exec` asks of the system beyond files and the chat webhook: the process a reviewed command runs in
 * and the checkout its binding names.
 */
export interface ExecPorts {
  readonly spawner: ExecSpawner;
  readonly checkout: CheckoutProbe;
}
