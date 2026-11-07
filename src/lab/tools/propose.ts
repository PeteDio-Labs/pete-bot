/**
 * propose_action (PET-869): how the model asks for a change.
 *
 * ⚠ THIS TOOL CHANGES NOTHING. It validates a request and returns a proposal. The server
 * hands the proposal to pete-bot, which shows a Confirm button, and a tap by the owner runs
 * it. A model that is steered by a title, a torrent name or a tracker message can propose,
 * and it still cannot act.
 *
 * ⚠ ONLY THREE ACTIONS EXIST, each fully specified: a subtitle search for ONE title that
 * resolved to ONE Bazarr item, an update check, and an update apply for one named target.
 * An ambiguous title throws with the candidates, so the model asks which one.
 */
import { z } from "zod";
import {
  listItems,
  matchTitle,
  type BazarrConfig,
  type BazarrKind,
} from "./bazarr.js";
import { LabToolError, type LabTool } from "./types.js";

/** Mirrors UPDATE_TARGETS in src/clients/githubActions.ts. A test keeps the two equal. */
export const PROPOSE_TARGETS = [
  "plex",
  "sonarr",
  "radarr",
  "prowlarr",
  "arr",
  "plex-and-arr",
] as const;
export const PROPOSE_TOOL = "propose_action";

export type Proposal =
  | {
      action: "subtitles";
      kind: BazarrKind;
      id: number;
      title: string;
      label: string;
      confirm: true;
    }
  | {
      action: "update_check";
      target: (typeof PROPOSE_TARGETS)[number];
      label: string;
      confirm: false;
    }
  | {
      action: "update_apply";
      target: (typeof PROPOSE_TARGETS)[number];
      label: string;
      confirm: true;
    };

export function proposeActionTool(bazarr: BazarrConfig | undefined): LabTool {
  const input = z.object({
    action: z.enum(["subtitles", "update_check", "update_apply"]),
    title: z
      .string()
      .min(2)
      .max(200)
      .optional()
      .describe("For subtitles: the title to search subtitles for"),
    target: z
      .enum(PROPOSE_TARGETS)
      .optional()
      .describe("For update_check and update_apply: which services"),
  });
  return {
    name: PROPOSE_TOOL,
    description:
      'Ask the user to confirm a change. This does not run it. Use action "subtitles" with a title to search for missing subtitles, ' +
      '"update_check" with a target to see which updates are available, or "update_apply" with a target to install them. ' +
      "Tell the user what you proposed and that a Confirm button will follow.",
    input,
    async run({ action, title, target }: z.infer<typeof input>) {
      if (action === "subtitles") {
        if (!title)
          throw new LabToolError("propose_action: subtitles needs a title");
        if (!bazarr)
          throw new LabToolError(
            "propose_action: Bazarr is not configured on this host",
          );
        const matches = matchTitle(await listItems(bazarr), title);
        if (matches.length === 0)
          throw new LabToolError(
            `propose_action: Bazarr has no title matching "${title.slice(0, 60)}"`,
          );
        if (matches.length > 1) {
          throw new LabToolError(
            `propose_action: "${title.slice(0, 60)}" matches ${matches.length} titles (${matches
              .slice(0, 6)
              .map((m) => m.title)
              .join("; ")}). Ask which one.`,
          );
        }
        const m = matches[0]!;
        const proposal: Proposal = {
          action: "subtitles",
          kind: m.kind,
          id: m.id,
          title: m.title,
          label: `Search subtitles for ${m.title} (${m.missing} missing)`,
          confirm: true,
        };
        return {
          source: `Bazarr: one title matched "${title.slice(0, 60)}"`,
          data: {
            proposal,
            pending: "The user must tap Confirm. Nothing has run.",
          },
        };
      }
      if (!target)
        throw new LabToolError(
          `propose_action: ${action} needs a target (${PROPOSE_TARGETS.join(", ")})`,
        );
      const proposal: Proposal =
        action === "update_check"
          ? {
              action,
              target,
              label: `Check updates for ${target}`,
              confirm: false,
            }
          : {
              action,
              target,
              label: `Install updates for ${target}`,
              confirm: true,
            };
      return {
        source: "media-updates.yml targets",
        data: {
          proposal,
          pending: proposal.confirm
            ? "The user must tap Confirm. Nothing has run."
            : "The check starts now and its report follows.",
        },
      };
    },
  };
}
