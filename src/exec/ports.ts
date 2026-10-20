import type { CheckoutProbe } from './binding.ts';
import type { ExecSpawner } from './runner.ts';
import type { ExecWebhook } from './webhook.ts';

/**
 * What `teamrig exec` asks of the system beyond files: the process a reviewed command runs in, the checkout its
 * binding names, and the webhook its reviews and runs are posted to.
 */
export interface ExecPorts {
  readonly spawner: ExecSpawner;
  readonly checkout: CheckoutProbe;
  readonly webhook: ExecWebhook;
}
