import { defineConnector } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/** The GitHub adapter. It builds no port yet: each one moves here from the core as the port split names it. */
export default defineConnector({ declaration, create: () => ({}) });
