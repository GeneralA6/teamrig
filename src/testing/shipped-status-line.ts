import { isUnsupported, type StatusLine, type UsageMeter } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';
import { shippedUsage } from './shipped-usage.ts';

/**
 * The shipped host's status line, as a quiet world's run carries it: a spec of code that reads a status input asks
 * here, never an adapter's own file. A host that draws no status line fails the spec with its reason.
 */
export function shippedStatusLine(): StatusLine {
  const { statusLine } = quietWorld().host({ env: {}, platform: 'linux' });
  if (isUnsupported(statusLine)) {
    throw new Error(`the shipped host draws no status line: ${statusLine.notice}`);
  }
  return statusLine;
}

/** The shipped host's two readers of a status input: its status line, and its usage meter for the plan's windows. */
export function shippedStatusSource(): { readonly statusLine: StatusLine; readonly usage: UsageMeter } {
  return { statusLine: shippedStatusLine(), usage: shippedUsage() };
}
