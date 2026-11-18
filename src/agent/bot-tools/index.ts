export {
  MAX_BOT_HOPS,
  BOT_COLLAB_TOOL_DECLARATIONS,
  filterToolDeclarationsForSkills,
  redactToolArgsForDisplay,
  isBotCollabTool,
} from "./declarations.js";
export { saveGeneratedImageFile } from "./integrations.js";
export { resolveBotByRef, deliverInterBotMessage } from "./collab-tools.js";

import { handleCollabBotTool } from "./collab-tools.js";
import { UNHANDLED_BOT_TOOL, handleIntegrationBotTool } from "./integrations.js";
import { handleSystemBotTool } from "./system-tools.js";

export async function runBotCollabTool(
  name: string,
  args: Record<string, any> = {},
  ctx: Record<string, any> = {}
) {
  for (const handler of [handleCollabBotTool, handleIntegrationBotTool, handleSystemBotTool]) {
    const res = await handler(name, args, ctx);
    if (res !== UNHANDLED_BOT_TOOL) return res;
  }
  return { error: `unknown bot collaboration tool: ${name}` };
}
