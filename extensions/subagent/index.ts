import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ALLOWED_CHILD_TOOLS } from "./agents.ts";
import { runSubagent, type SubagentParams } from "./runner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TaskItem = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 64, description: "Name of the agent to invoke" }),
	task: Type.String({ minLength: 1, maxLength: 2000, description: "Task to delegate to the agent" }),
});

const AgentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
	description:
		'Which agent directories to use with the bundled agents. Default: "user" (bundled + ~/.ti-trader/agent/agents).',
});

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(
		Type.String({ minLength: 1, maxLength: 64, description: "Name of the agent to invoke (single mode)" }),
	),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for sequential execution. Use {previous} for prior output.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
});

function userAgentsDir(): string {
	const root = process.env.TI_DATA_DIR?.trim() || path.join(homedir(), ".ti-trader");
	return path.join(root, "agent", "agents");
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate research to an isolated subagent. Children have no exchange credentials.",
			"They may propose_order; that does not submit. You must check_order then buy/sell to place it.",
			"Paper/unattended: your buy/sell is the approval. Live/confirm: buy/sell waits for the operator.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous}).",
			"Bundled agents: researcher, scanner, reviewer.",
			`Child tools are always a subset of ${ALLOWED_CHILD_TOOLS.join(", ")}.`,
		].join(" "),
		parameters: SubagentParamsSchema,
		promptGuidelines: [
			"Use subagent for isolated research. Children cannot submit orders.",
			"propose_order is a parent-pending proposal. check_order then buy/sell if you accept it.",
			"Paper/unattended: buy/sell is your approval. Live/confirm: the operator confirmation box still appears.",
			"Default agents: researcher (may propose), scanner, reviewer.",
			"Single: agent + task. Parallel: tasks[]. Chain: chain[] with {previous}.",
		],
		async execute(_id, params, signal, onUpdate, ctx) {
			const output = await runSubagent(
				params as SubagentParams,
				{
					cwd: ctx.cwd,
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					thinkingLevel: ctx.thinkingLevel,
					hasUI: ctx.hasUI,
					isProjectTrusted: () => ctx.isProjectTrusted(),
					confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
				},
				{
					bundledDir: path.join(HERE, "agents"),
					userDir: userAgentsDir(),
					extensionFileUrl: import.meta.url,
					signal: signal ?? new AbortController().signal,
					onUpdate,
				},
			);
			return output;
		},
	});
}

export { ALLOWED_CHILD_TOOLS, discoverAgents, parseToolList, resolveChildTools } from "./agents.ts";
export { buildProposedOrder, extractProposedOrder, formatProposedOrders, PROPOSE_ORDER_TOOL } from "./child-orders.ts";
export {
	assistantText,
	childEnvironment,
	resolveChildOrdersExtension,
	resolveCodingAgentCli,
	resolveSiblingMarketLab,
	runIsolatedChild,
} from "./isolated-child.ts";
export { buildChildSystemPrompt, PER_TASK_OUTPUT_CAP, runSubagent, truncateBytes } from "./runner.ts";
