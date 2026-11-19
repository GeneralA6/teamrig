import { defineConnector } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/** The local adapter: the connector of a team that keeps its tasks in the register and reaches no outside tool. */
export default defineConnector({ declaration, create: () => ({}) });
