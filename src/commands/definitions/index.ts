// Command definitions. Two: /ask, which forwards to mtrace, and /status, which asks
// whether mtrace is there at all.
//
// /help is gone with the tool layer it documented — it listed mission_control,
// web_search and calculate, none of which exist here now. mtrace's own /api/tools
// is the live answer to "what can it do", and it cannot drift from the tool set.
import { askCommand } from './ask.js';
import { statusCommand } from './status.js';

export { askCommand, statusCommand };
export const allCommands = [askCommand, statusCommand];
