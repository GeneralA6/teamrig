import { defineHost } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';
import { statusLine } from './status-line.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

/** The Claude Code adapter. Each port moves here from the core as the port split names it. */
export default defineHost({ declaration, create: () => ({ transcripts: transcriptReader, usage: usageMeter, statusLine }) });
