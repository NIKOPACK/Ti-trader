import { fileURLToPath } from "node:url";
import {
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
	ALLOWED_CHILD_TOOLS,
	discoverAgents,
	resolveChildTools,
} from "./agents.ts";
import { formatProposedOrders, PROPOSE_ORDER_TOOL, type ProposedOrder } from "./child-orders.ts";
import {
	assistantText,
	type IsolatedChildEvent,
	type IsolatedChildMessage,
	type IsolatedChildRequest,
	type IsolatedChildResult,
	resolveChildOrdersExtension,
	resolveSiblingMarketLab,
	runIsolatedChild,
} from "./isolated-child.ts";

export const MAX_PARALLEL_TASKS = 4;
export const MAX_CONCURRENCY = 2;
export const MAX_CHAIN_STEPS = 8;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

const SAFETY_PROMPT = [
	"You are a Ti research subagent with no exchange access.",
	`You may only use ${ALLOWED_CHILD_TOOLS.join(", ")}.`,
	"propose_order queues an order for the parent. It does not submit, fill, reserve quota, or touch the exchange.",
	"Never claim a fill. Never access accounts, credentials, or shell.",
	"Use closed public Binance spot candles only.",
	"Return a concise report with data quality, timestamps, sources, risks, and non-binding bias.",
	"Bias is not an order. A proposal is not a fill.",
].join("\n");

export type SubagentMode = "single" | "parallel" | "chain";

export type SubagentTask = {
	agent: string;
	task: string;
};

export type SubagentParams = {
	agent?: string;
	task?: string;
	tasks?: SubagentTask[];
	chain?: SubagentTask[];
	agentScope?: AgentScope;
	/** Ignored. Untrusted project agents always require confirmation. */
	confirmProjectAgents?: boolean;
	/** Ignored. Children always run in the parent cwd. */
	cwd?: string;
};

export type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

export type SingleResult = {
	agent: string;
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	exitCode: number;
	messages: IsolatedChildMessage[];
	proposals: ProposedOrder[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
};

export type SubagentDetails = {
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	proposals: ProposedOrder[];
};

export type SubagentContent = { type: "text"; text: string };

export type SubagentOutput = {
	content: SubagentContent[];
	details: SubagentDetails;
	isError?: boolean;
};

export type SubagentContext = {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	hasUI: boolean;
	isProjectTrusted: () => boolean;
	confirm?: (title: string, message: string) => Promise<boolean>;
};

export type RunChild = (request: IsolatedChildRequest) => Promise<IsolatedChildResult>;

export type SubagentRunnerOptions = {
	bundledDir: string;
	userDir: string;
	extensionFileUrl: string;
	signal: AbortSignal;
	onUpdate?: (output: SubagentOutput) => void;
	runChild?: RunChild;
	discover?: typeof discoverAgents;
	marketLabPath?: string;
	childOrdersPath?: string;
};

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function accumulateUsage(messages: IsolatedChildMessage[]): UsageStats {
	const usage = emptyUsage();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		usage.turns += 1;
		if (message.usage) {
			usage.input += message.usage.input ?? 0;
			usage.output += message.usage.output ?? 0;
			usage.cacheRead += message.usage.cacheRead ?? 0;
			usage.cacheWrite += message.usage.cacheWrite ?? 0;
			usage.cost += message.usage.cost?.total ?? 0;
			if (message.usage.totalTokens && message.usage.totalTokens > 0) {
				usage.contextTokens = message.usage.totalTokens;
			}
		}
	}
	return usage;
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || assistantText(result.messages) || "(no output)";
	}
	return assistantText(result.messages) || "(no output)";
}

export function truncateBytes(output: string, cap = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;
	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
	return truncated;
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	const truncated = truncateBytes(output);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function formatUsageStats(usage: UsageStats): string {
	if (!usage.input && !usage.output && !usage.cost) return "";
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function withUsage(text: string, usage: UsageStats, proposals: readonly ProposedOrder[] = []): string {
	const body = `${text}${formatProposedOrders(proposals)}`;
	const stats = formatUsageStats(usage);
	return stats ? `${body}\n\n${stats}` : body;
}

function collectProposals(results: readonly SingleResult[]): ProposedOrder[] {
	return results.flatMap((result) => result.proposals);
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
		if (result.usage.contextTokens > total.contextTokens) total.contextTokens = result.usage.contextTokens;
	}
	return total;
}

export function buildChildSystemPrompt(agentPrompt: string): string {
	const body = agentPrompt.trim();
	return body ? `${SAFETY_PROMPT}\n\n${body}` : SAFETY_PROMPT;
}

function availableText(agents: AgentConfig[]): string {
	return agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
}

function failedResult(agentName: string, task: string, message: string, source?: AgentConfig["source"]): SingleResult {
	return {
		agent: agentName,
		agentSource: source ?? "unknown",
		task,
		exitCode: 1,
		messages: [],
		proposals: [],
		stderr: message,
		usage: emptyUsage(),
		errorMessage: message,
	};
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function requestedAgentNames(params: SubagentParams): string[] {
	const names = new Set<string>();
	if (params.agent) names.add(params.agent);
	if (params.tasks) for (const task of params.tasks) names.add(task.agent);
	if (params.chain) for (const step of params.chain) names.add(step.agent);
	return [...names];
}

async function runSingleAgent(input: {
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	marketLabPath: string;
	childOrdersPath: string;
	signal: AbortSignal;
	step?: number;
	runChild: RunChild;
	onUpdate?: (result: SingleResult) => void;
}): Promise<SingleResult> {
	const agent = input.agents.find((candidate) => candidate.name === input.agentName);
	if (!agent) {
		const available = input.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		return failedResult(
			input.agentName,
			input.task,
			`Unknown agent: "${input.agentName}". Available agents: ${available}.`,
		);
	}

	const resolved = resolveChildTools(agent.tools);
	if (resolved.rejected.length > 0) {
		return failedResult(
			agent.name,
			input.task,
			`Agent "${agent.name}" requested tools outside the read-only allowlist: ${resolved.rejected.join(", ")}. Allowed: ${ALLOWED_CHILD_TOOLS.join(", ")}.`,
			agent.source,
		);
	}

	const current: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: input.task,
		exitCode: 0,
		messages: [],
		proposals: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model ?? input.model,
		step: input.step,
	};
	const emit = (): void => input.onUpdate?.(current);
	const extensionPaths = [input.marketLabPath];
	if (resolved.tools.includes(PROPOSE_ORDER_TOOL)) extensionPaths.push(input.childOrdersPath);

	try {
		const child = await input.runChild({
			cwd: input.cwd,
			prompt: `Task: ${input.task}`,
			systemPrompt: buildChildSystemPrompt(agent.systemPrompt),
			tools: resolved.tools,
			extensionPaths,
			model: current.model,
			thinkingLevel: agent.model ? undefined : input.thinkingLevel,
			signal: input.signal,
			onEvent: (event: IsolatedChildEvent) => {
				if (event.type === "tool_execution_end") return;
				current.messages.push(event.message);
				if (event.message.role === "assistant") {
					current.usage = accumulateUsage(current.messages);
					if (event.message.model) current.model = event.message.model;
					if (event.message.stopReason) current.stopReason = event.message.stopReason;
					if (event.message.errorMessage) current.errorMessage = event.message.errorMessage;
				}
				emit();
			},
		});
		current.exitCode = child.exitCode;
		current.stderr = child.stderr;
		if (current.messages.length === 0) current.messages = child.messages;
		current.proposals = child.proposals ?? [];
		current.usage = accumulateUsage(current.messages);
		if (child.error) current.errorMessage = child.error;
		if (child.aborted) current.stopReason = "aborted";
		else if (child.timedOut || child.outputTooLarge) current.stopReason = "error";
		return current;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return failedResult(agent.name, input.task, message, agent.source);
	}
}

async function confirmProjectAgentsIfNeeded(
	params: SubagentParams,
	ctx: SubagentContext,
	discovery: AgentDiscoveryResult,
): Promise<SubagentOutput | undefined> {
	const agentScope = params.agentScope ?? "user";
	if (agentScope !== "project" && agentScope !== "both") return undefined;

	const requested = new Set(requestedAgentNames(params));
	const projectAgentsRequested = discovery.agents.filter(
		(agent) => requested.has(agent.name) && agent.source === "project",
	);
	if (projectAgentsRequested.length === 0) return undefined;

	const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
	const dir = discovery.projectAgentsDir ?? "(unknown)";
	const trusted = ctx.isProjectTrusted();
	if (trusted) return undefined;

	if (ctx.hasUI && ctx.confirm) {
		const ok = await ctx.confirm(
			"Run project-local agents?",
			`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (ok) return undefined;
	}

	const mode: SubagentMode = params.chain?.length ? "chain" : params.tasks?.length ? "parallel" : "single";
	return {
		content: [
			{
				type: "text",
				text: "Canceled: project-local agents require confirmation in a trusted project.",
			},
		],
		details: { mode, agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [], proposals: [] },
		isError: true,
	};
}

export async function runSubagent(
	params: SubagentParams,
	ctx: SubagentContext,
	options: SubagentRunnerOptions,
): Promise<SubagentOutput> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discover = options.discover ?? discoverAgents;
	const runChild = options.runChild ?? runIsolatedChild;
	const extensionFile = fileURLToPath(options.extensionFileUrl);
	const marketLabPath = options.marketLabPath ?? resolveSiblingMarketLab(extensionFile);
	const childOrdersPath = options.childOrdersPath ?? resolveChildOrdersExtension(extensionFile);
	const discovery = discover({
		cwd: ctx.cwd,
		scope: agentScope,
		bundledDir: options.bundledDir,
		userDir: options.userDir,
	});
	const agents = discovery.agents;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	const makeDetails = (mode: SubagentMode, results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
		proposals: collectProposals(results),
	});
	const invalid = (mode: SubagentMode, text: string, results: SingleResult[] = []): SubagentOutput => ({
		content: [{ type: "text", text }],
		details: makeDetails(mode, results),
		isError: true,
	});

	if (modeCount !== 1) {
		return invalid(
			"single",
			`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${availableText(agents)}`,
		);
	}

	const canceled = await confirmProjectAgentsIfNeeded(params, ctx, discovery);
	if (canceled) return canceled;

	const run = (
		agentName: string,
		task: string,
		step: number | undefined,
		onUpdate?: (result: SingleResult) => void,
	): Promise<SingleResult> =>
		runSingleAgent({
			agents,
			agentName,
			task,
			cwd: ctx.cwd,
			model,
			thinkingLevel: ctx.thinkingLevel,
			marketLabPath,
			childOrdersPath,
			signal: options.signal,
			step,
			runChild,
			onUpdate,
		});

	if (params.chain && params.chain.length > 0) {
		if (params.chain.length > MAX_CHAIN_STEPS) {
			return invalid("chain", `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.`);
		}
		const results: SingleResult[] = [];
		let previousOutput = "";
		for (let index = 0; index < params.chain.length; index++) {
			const step = params.chain[index];
			const task = step.task.replaceAll("{previous}", truncateBytes(previousOutput));
			const result = await run(step.agent, task, index + 1, (current) => {
				options.onUpdate?.({
					content: [{ type: "text", text: assistantText(current.messages) || "(running...)" }],
					details: makeDetails("chain", [...results, current]),
				});
			});
			results.push(result);
			if (isFailedResult(result)) {
				return invalid(
					"chain",
					`Chain stopped at step ${index + 1} (${step.agent}): ${getResultOutput(result)}`,
					results,
				);
			}
			previousOutput = assistantText(result.messages);
		}
		return {
			content: [
				{
					type: "text",
					text: withUsage(
						assistantText(results[results.length - 1].messages) || "(no output)",
						aggregateUsage(results),
						collectProposals(results),
					),
				},
			],
			details: makeDetails("chain", results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			return invalid("parallel", `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
		}
		const allResults: SingleResult[] = params.tasks.map((task) => ({
			agent: task.agent,
			agentSource: "unknown",
			task: task.task,
			exitCode: -1,
			messages: [],
			proposals: [],
			stderr: "",
			usage: emptyUsage(),
		}));
		const emitParallel = (): void => {
			const running = allResults.filter((result) => result.exitCode === -1).length;
			const done = allResults.filter((result) => result.exitCode !== -1).length;
			options.onUpdate?.({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetails("parallel", [...allResults]),
			});
		};
		const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
			const result = await run(task.agent, task.task, undefined, (current) => {
				allResults[index] = current;
				emitParallel();
			});
			allResults[index] = result;
			emitParallel();
			return result;
		});
		const successCount = results.filter((result) => !isFailedResult(result)).length;
		const summaries = results.map((result) => {
			const output = truncateParallelOutput(getResultOutput(result));
			const status = isFailedResult(result)
				? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
				: "completed";
			return `### [${result.agent}] ${status}\n\n${output}`;
		});
		const failed = successCount !== results.length;
		return {
			content: [
				{
					type: "text",
					text: withUsage(
						`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						aggregateUsage(results),
						collectProposals(results),
					),
				},
			],
			details: makeDetails("parallel", results),
			isError: failed || undefined,
		};
	}

	if (params.agent && params.task) {
		const result = await run(params.agent, params.task, undefined, (current) => {
			options.onUpdate?.({
				content: [{ type: "text", text: assistantText(current.messages) || "(running...)" }],
				details: makeDetails("single", [current]),
			});
		});
		if (isFailedResult(result)) {
			return invalid("single", `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`, [result]);
		}
		return {
			content: [
				{
					type: "text",
					text: withUsage(assistantText(result.messages) || "(no output)", result.usage, result.proposals),
				},
			],
			details: makeDetails("single", [result]),
		};
	}

	return invalid("single", `Invalid parameters. Available agents: ${availableText(agents)}`);
}
