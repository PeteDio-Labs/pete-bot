// /code command handler — coding agent plan + approval flow
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import { generatePlan, executePlan, updatePlanState, type CodePlan, type StepResult } from '../../ai/CodePlanExecutor.js';
import { isUserAuthorized, logger } from '../../utils/index.js';

const RISK_EMOJI: Record<string, string> = {
  READ_ONLY: '🟢',
  SAFE_MUTATE: '🟡',
  DESTRUCTIVE: '🔴',
};

function buildPlanEmbed(plan: CodePlan): EmbedBuilder {
  const stepLines = plan.steps.map((s) =>
    `${RISK_EMOJI[s.risk_tier] ?? '⚪'} **${s.step}.** ${s.description} \`[${s.risk_tier}]\``
  );

  const hasDestructive = plan.steps.some((s) => s.risk_tier === 'DESTRUCTIVE');

  return new EmbedBuilder()
    .setColor(hasDestructive ? 0xff4444 : 0x5865f2)
    .setTitle('Coding Agent — Proposed Plan')
    .addFields({ name: 'Task', value: plan.task.substring(0, 1024), inline: false })
    .addFields({ name: 'Steps', value: stepLines.join('\n').substring(0, 1024), inline: false })
    .addFields({
      name: 'Risk',
      value: hasDestructive
        ? '🔴 Contains DESTRUCTIVE steps — these will execute on Approve'
        : '✅ No destructive steps',
      inline: false,
    })
    .setFooter({ text: `Plan ID: ${plan.id.slice(0, 8)}` })
    .setTimestamp();
}

function buildResultEmbed(plan: CodePlan, results: StepResult[]): EmbedBuilder {
  const allOk = results.every((r) => r.success);
  const lines = results.map((r) =>
    `${r.success ? '✅' : '❌'} **${r.step}.** ${r.description}\n\`\`\`\n${r.output.substring(0, 300)}\n\`\`\``
  );

  return new EmbedBuilder()
    .setColor(allOk ? 0x2ecc71 : 0xff4444)
    .setTitle(`Coding Agent — ${allOk ? 'Done' : 'Failed'}`)
    .addFields({ name: 'Task', value: plan.task.substring(0, 256), inline: false })
    .setDescription(lines.join('\n').substring(0, 4096))
    .setTimestamp();
}

export async function handleCodeCommand(
  interaction: ChatInputCommandInteraction,
  ollamaHost: string,
  coderModel: string,
  allowedUsers: string[],
): Promise<void> {
  logger.info(`/code command from ${interaction.user.tag}`);

  if (!isUserAuthorized(interaction.user.id, allowedUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  try {
    await interaction.deferReply();
  } catch {
    return;
  }

  const task = interaction.options.getString('task', true);

  try {
    // Generate plan using petedio-coder
    const plan = await generatePlan(task, ollamaHost, coderModel);

    const embed = buildPlanEmbed(plan);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`codeplan_approve_${plan.id}`)
        .setLabel('Approve & Execute')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`codeplan_cancel_${plan.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
    logger.info(`[Code] Plan ${plan.id.slice(0, 8)} sent for approval`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Code] Plan generation failed:', err);
    await interaction.editReply({ content: `Failed to generate plan: ${msg}` });
  }
}

// Called from buttonHandler when codeplan_approve_* fires
export async function handleCodePlanApprove(
  planId: string,
  client: Client,
  ownerUserId: string,
  plan: CodePlan,
): Promise<void> {
  updatePlanState(planId, 'approved');
  logger.info(`[Code] Plan ${planId.slice(0, 8)} approved — executing`);

  try {
    const results = await executePlan(plan);
    const embed = buildResultEmbed(plan, results);

    const owner = await client.users.fetch(ownerUserId);
    const dm = await owner.createDM();
    await dm.send({ embeds: [embed] });
  } catch (err) {
    logger.error('[Code] Plan execution error:', err);
    try {
      const owner = await client.users.fetch(ownerUserId);
      const dm = await owner.createDM();
      await dm.send({ content: `Code plan execution failed: ${err instanceof Error ? err.message : String(err)}` });
    } catch {
      // DM failed silently
    }
  }
}

export default handleCodeCommand;
