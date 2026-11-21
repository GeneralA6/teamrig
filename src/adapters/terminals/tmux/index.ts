import { defineTerminal } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/** The tmux adapter. It builds no port yet: its launcher calls move here from the core's open path. */
export default defineTerminal({ declaration, create: () => ({}) });
