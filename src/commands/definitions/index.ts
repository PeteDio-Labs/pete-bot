// Command definitions. Three: /ask, which forwards to mtrace; /status, which asks
// whether mtrace is there at all; and /update, which starts a media update through
// GitHub Actions (PET-395).
//
// /help is gone with the tool layer it documented — it listed mission_control,
// web_search and calculate, none of which exist here now. mtrace's own /api/tools
// is the live answer to "what can it do", and it cannot drift from the tool set.
import { askCommand } from './ask.js';
import { statusCommand } from './status.js';
import { updateCommand } from './update.js';

export { askCommand, statusCommand, updateCommand };
export const allCommands = [askCommand, statusCommand, updateCommand];
