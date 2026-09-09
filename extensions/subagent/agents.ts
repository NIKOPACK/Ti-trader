/**
 * Discover Ti subagent definitions and keep their tools inside the
 * read-only market-lab allowlist.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const ALLOWED_CHILD_TOOLS = [
	"calculate_indicators",
	"evaluate_strategy",
	"screen_markets",
	"simulate_rule",
	"propose_order",
] as const;

const ALLOWED_CHILD_TOOL_SET = new Set<string>(ALLOWED_CHILD_TOOLS);

export const PROJECT_CONFIG_DIR_NAME = ".ti-trader";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function resolveChildTools(requested: string[] | undefined): { tools: string[]; rejected: string[] } {
	if (requested === undefined) return { tools: [...ALLOWED_CHILD_TOOLS], rejected: [] };
	const tools: string[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	for (const name of requested) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (ALLOWED_CHILD_TOOL_SET.has(name)) tools.push(name);
		else rejected.push(name);
	}
	return { tools, rejected };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(input: {
	cwd: string;
	scope: AgentScope;
	bundledDir: string;
	userDir: string;
	projectConfigDirName?: string;
}): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(input.cwd, input.projectConfigDirName);
	const bundled = loadAgentsFromDir(input.bundledDir, "bundled");
	const userAgents = input.scope === "project" ? [] : loadAgentsFromDir(input.userDir, "user");
	const projectAgents =
		input.scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundled) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
