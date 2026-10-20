// Command definitions. Three: /status, which reports what pete-bot is holding, /update,
// which starts a media update through GitHub Actions (PET-395), and /lab, which asks the
// lab-map agent (PET-669). /report sends a scheduled report now (PET-701).
//
// /ask went in PET-518: Bobbert asks mtrace with its own token now. /help went with the
// tool layer it documented — it listed mission_control, web_search and calculate, none of
// which exist here now.
import { statusCommand } from './status.js';
import { updateCommand } from './update.js';
import { labCommand } from './lab.js';
import { reportCommand } from './report.js';

export { statusCommand, updateCommand, labCommand, reportCommand };
export const allCommands = [statusCommand, updateCommand, labCommand, reportCommand];
