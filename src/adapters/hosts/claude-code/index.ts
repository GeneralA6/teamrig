import { defineHost } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/** The Claude Code adapter. It builds no port yet: each one moves here from the core as the port split names it. */
export default defineHost({ declaration, create: () => ({}) });
