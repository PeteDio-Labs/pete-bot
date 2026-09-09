// Command definitions. One command: /ask, which forwards to mtrace.
//
// /help is gone with the tool layer it documented — it listed mission_control,
// web_search and calculate, none of which exist here now. mtrace's own /api/tools
// is the live answer to "what can it do", and it cannot drift from the tool set.
import { askCommand } from './ask.js';

export { askCommand };
export const allCommands = [askCommand];
