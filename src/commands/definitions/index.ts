// Command definitions. Two: /status, which reports what pete-bot is holding, and
// /update, which starts a media update through GitHub Actions (PET-395).
//
// /ask went in PET-518: Bobbert asks mtrace with its own token now. /help went with the
// tool layer it documented — it listed mission_control, web_search and calculate, none of
// which exist here now.
import { statusCommand } from './status.js';
import { updateCommand } from './update.js';

export { statusCommand, updateCommand };
export const allCommands = [statusCommand, updateCommand];
