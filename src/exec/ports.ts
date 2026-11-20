import type { CheckoutProbe } from './binding.ts';
import type { ExecSpawner } from './runner.ts';
import type { RuntimeProbe } from './runtime-pin.ts';

/**
 * What `teamrig exec` asks of the system beyond files and the chat webhook: the process a reviewed command runs in,
 * the checkout its binding names, and the Node.js runtime the client runs under, which the runtime pin names (#870).
 */
export interface ExecPorts {
  readonly spawner: ExecSpawner;
  readonly checkout: CheckoutProbe;
  readonly runtime: RuntimeProbe;
}
