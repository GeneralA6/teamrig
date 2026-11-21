import { unsupported, type HostPorts } from '../ports/host/index.ts';

/**
 * A host that fills no port, each with its own reason: what a spec hands a command to see how it runs on a host
 * lacking a port. Every spec asks here, so a new port adds its line once and no spec's literal goes stale.
 */
export function bareHost(): HostPorts {
  return {
    hooks: unsupported('no hook is called'),
    toolCall: unsupported('no tool call is read'),
    transcripts: unsupported('no transcript is kept'),
    usage: unsupported('no call is priced'),
    statusLine: unsupported('no status line is drawn'),
    paths: unsupported('no folder of the host is known'),
    permissions: unsupported('no permission rule is kept'),
  };
}
