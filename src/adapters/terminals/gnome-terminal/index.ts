import { defineTerminal } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/** The GNOME Terminal adapter. It builds no port yet: its launcher call moves here from the core's open path. */
export default defineTerminal({ declaration, create: () => ({}) });
