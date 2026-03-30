/**
 * CodePlanExecutor
 *
 * Drives the coding agent planning loop:
 *   1. Ask petedio-coder to produce a JSON plan from a task description
 *   2. Store the plan keyed by UUID
 *   3. On human approval, execute steps in order using code_ops
 *   4. DESTRUCTIVE steps are skipped unless confirmed=true is already set in args
 *      (the plan generation prompt sets confirmed=true for steps the LLM marks destructive
 *       so the human's button click IS the confirmation)
 */
import { randomUUID } from 'node:crypto';
import { Ollama } from 'ollama';
import type { Message } from 'ollama';
import { registry } from './ToolRegistry.js';
import { logger } from '../utils/index.js';

export type RiskTier = 'READ_ONLY' | 'SAFE_MUTATE' | 'DESTRUCTIVE';

export interface PlanStep {
  step: number;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  risk_tier: RiskTier;
}

export interface CodePlan {
  id: string;
  task: string;
  steps: PlanStep[];
  createdAt: Date;
  state: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';
}

// In-memory store — plans expire after 30 minutes
const PLAN_TTL_MS = 30 * 60 * 1000;
const plans = new Map<string, CodePlan>();

function pruneExpired(): void {
  const cutoff = Date.now() - PLAN_TTL_MS;
  for (const [id, plan] of plans) {
    if (plan.createdAt.getTime() < cutoff) plans.delete(id);
  }
}

export function getPlan(id: string): CodePlan | undefined {
  pruneExpired();
  return plans.get(id);
}

export function updatePlanState(id: string, state: CodePlan['state']): void {
  const plan = plans.get(id);
  if (plan) plan.state = state;
}

const PLAN_SYSTEM_PROMPT = `You are a coding agent planner for the PeteDio Labs monorepo.

Given a task, output ONLY a valid JSON array of steps. No explanation outside the JSON.

Each step must have:
- "step": integer (1-based)
- "description": short human-readable description
- "tool": always "code_ops"
- "args": object matching code_ops tool args (action + relevant params)
- "risk_tier": "READ_ONLY" | "SAFE_MUTATE" | "DESTRUCTIVE"

Rules:
- Always start with READ_ONLY steps to gather context before proposing changes
- Set confirmed=true in args for all DESTRUCTIVE steps (human button approval IS the gate)
- Keep plans short — 3-8 steps max
- For file reads use action: "read_file" with the absolute path
- For kubectl reads use action: "kubectl_get" / "kubectl_logs" / "kubectl_describe"
- For PR creation use action: "gh_pr_create" with repo, title, body, base, head

Example output:
[
  {"step":1,"description":"Read current pipeline config","tool":"code_ops","args":{"action":"read_file","path":"/home/pedro/PeteDio-Labs/apps/blog/blog-agent/src/services/pipeline.ts"},"risk_tier":"READ_ONLY"},
  {"step":2,"description":"Check recent pod logs","tool":"code_ops","args":{"action":"kubectl_logs","namespace":"blog-dev","name":"blog-agent","lines":50},"risk_tier":"READ_ONLY"}
]`;

export async function generatePlan(task: string, ollamaHost: string, coderModel: string): Promise<CodePlan> {
  pruneExpired();

  const client = new Ollama({ host: ollamaHost });
  const messages: Message[] = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: `Task: ${task}` },
  ];

  logger.info(`[CodePlan] Generating plan for: "${task.substring(0, 80)}"`);

  const response = await client.chat({
    model: coderModel,
    messages,
    stream: false,
  });

  const raw = response.message.content?.trim() ?? '';
  logger.debug(`[CodePlan] Raw response: ${raw.substring(0, 500)}`);

  // Strip markdown fences if present
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let steps: PlanStep[];
  try {
    steps = JSON.parse(jsonStr) as PlanStep[];
    if (!Array.isArray(steps)) throw new Error('Expected JSON array');
  } catch (err) {
    logger.error('[CodePlan] Failed to parse plan JSON:', err);
    logger.error('[CodePlan] Raw was:', raw);
    throw new Error(`Coding agent returned unparseable plan. Raw: ${raw.substring(0, 300)}`);
  }

  // Ensure DESTRUCTIVE steps have confirmed=true (human button = approval)
  for (const step of steps) {
    if (step.risk_tier === 'DESTRUCTIVE') {
      step.args.confirmed = true;
    }
  }

  const plan: CodePlan = {
    id: randomUUID(),
    task,
    steps,
    createdAt: new Date(),
    state: 'pending',
  };

  plans.set(plan.id, plan);
  logger.info(`[CodePlan] Plan ${plan.id.slice(0, 8)} created with ${steps.length} steps`);
  return plan;
}

export interface StepResult {
  step: number;
  description: string;
  risk_tier: RiskTier;
  success: boolean;
  output: string;
}

export async function executePlan(plan: CodePlan): Promise<StepResult[]> {
  updatePlanState(plan.id, 'executing');
  const results: StepResult[] = [];

  for (const step of plan.steps) {
    logger.info(`[CodePlan] Executing step ${step.step}: ${step.description} (${step.risk_tier})`);

    const tool = registry.get(step.tool);
    if (!tool) {
      const result: StepResult = {
        step: step.step,
        description: step.description,
        risk_tier: step.risk_tier,
        success: false,
        output: `Unknown tool: ${step.tool}`,
      };
      results.push(result);
      updatePlanState(plan.id, 'failed');
      return results;
    }

    try {
      const toolResult = await tool.execute(step.args);
      const output = toolResult.success
        ? summarizeResult(toolResult)
        : `Error: ${(toolResult as { error: string }).error}`;

      results.push({
        step: step.step,
        description: step.description,
        risk_tier: step.risk_tier,
        success: toolResult.success,
        output,
      });

      // Stop on first failure
      if (!toolResult.success) {
        logger.warn(`[CodePlan] Step ${step.step} failed — stopping execution`);
        updatePlanState(plan.id, 'failed');
        return results;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        step: step.step,
        description: step.description,
        risk_tier: step.risk_tier,
        success: false,
        output: `Exception: ${msg}`,
      });
      updatePlanState(plan.id, 'failed');
      return results;
    }
  }

  updatePlanState(plan.id, 'done');
  return results;
}

function summarizeResult(result: Record<string, unknown>): string {
  // For file content, show first 500 chars
  if (typeof result.content === 'string') {
    const preview = result.content.substring(0, 500);
    return result.content.length > 500 ? `${preview}\n… (truncated)` : preview;
  }
  // For command output
  if (typeof result.output === 'string') {
    const preview = result.output.substring(0, 500);
    return result.output.length > 500 ? `${preview}\n… (truncated)` : preview;
  }
  // For PR URL
  if (typeof result.pr_url === 'string') return `PR created: ${result.pr_url}`;
  // For list results
  if (Array.isArray(result.prs)) return `${result.prs.length} PRs found`;
  if (Array.isArray(result.runs)) return `${result.runs.length} runs found`;
  return JSON.stringify(result).substring(0, 300);
}
