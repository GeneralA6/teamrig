/**
 * `teamrig queue`'s flags and switches, apart from the command so the command table and the queue's dispatcher, which
 * reads each parked step's arguments as the CLI would, share one list without loading the whole queue at start.
 */
export const QUEUE_FLAGS = ['session', 'what', 'max-minutes', 'kind', 'task', 'memory-mb', 'detached-run', 'arrived-at'];
export const QUEUE_SWITCHES = ['small', 'exclusive', 'pre-push', 'detach', 'dispatch'];
