import {
	hasTrustRequiringProjectResources,
	type ProjectTrustContext,
	type ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "./config.ts";

export type DefaultProjectTrust = "ask" | "always" | "never";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: "interactive" | "print";
	hasUI: boolean;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const prefix = type === "error" ? "error: " : type === "warning" ? "warning: " : "";
					console.error(`${prefix}${message}`);
				}
			},
		},
	};
}

export async function resolveProjectTrusted(options: {
	cwd: string;
	trustStore: ProjectTrustStore;
	projectConfigDirName?: string;
	defaultProjectTrust?: DefaultProjectTrust;
	projectTrustContext: ProjectTrustContext;
}): Promise<boolean> {
	const projectConfigDirName = options.projectConfigDirName ?? CONFIG_DIR_NAME;
	if (
		!hasTrustRequiringProjectResources(options.cwd, {
			projectConfigDirName,
		})
	) {
		return true;
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await options.projectTrustContext.ui.select(
		`Trust project folder?\n${options.cwd}\n\nThis allows ti to load ${projectConfigDirName} settings and resources.`,
		["Trust", "Do not trust"],
	);
	if (selected === "Trust") {
		options.trustStore.set(options.cwd, true);
		return true;
	}
	if (selected === "Do not trust") {
		options.trustStore.set(options.cwd, false);
		return false;
	}
	return false;
}
