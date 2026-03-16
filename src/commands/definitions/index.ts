// Command definitions barrel export
export { askCommand } from './ask.js';
export { infoCommand } from './info.js';
export { toolsCommand } from './tools.js';
export { helpCommand } from './help.js';

import { askCommand } from './ask.js';
import { infoCommand } from './info.js';
import { toolsCommand } from './tools.js';
import { helpCommand } from './help.js';

export const allCommands = [askCommand, infoCommand, toolsCommand, helpCommand];
