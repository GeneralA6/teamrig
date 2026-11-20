import { isUnsupported, type TranscriptReader } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';

/**
 * The shipped host's transcript reader, as a quiet world's run carries it: a spec of a reader of transcript lines
 * reads its lines through this, never through an adapter's own file. A host that cannot read transcripts fails
 * the spec with its reason.
 */
export function shippedTranscripts(): TranscriptReader {
  const { transcripts } = quietWorld().host({ env: {}, platform: 'linux' });
  if (isUnsupported(transcripts)) {
    throw new Error(`the shipped host reads no transcripts: ${transcripts.notice}`);
  }
  return transcripts;
}
