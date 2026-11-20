import { defineHost, unsupported } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import { statusLine } from './status-line.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

const NOT_MOVED = 'the core still reads this itself: the port is named and its code has not moved here yet';

/** The Claude Code adapter. Each port moves here from the core as the port split names it. */
export default defineHost({
  declaration,
  create: () => ({ hooks: unsupported(NOT_MOVED), toolCall: unsupported(NOT_MOVED), transcripts: transcriptReader, usage: usageMeter, statusLine }),
});
