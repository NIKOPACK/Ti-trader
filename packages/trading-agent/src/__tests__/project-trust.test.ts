import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectTrustContext, resolveProjectTrusted } from "../project-trust.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
	const root = mkdtempSync(join(tmpdir(), "ti-project-trust-"));
	roots.push(root);
	return root;
}

describe("createProjectTrustContext", () => {
	it("maps interactive mode to tui and keeps print prompts off the TUI", async () => {
		const interactive = createProjectTrustContext({
			cwd: "/tmp/project",
			mode: "interactive",
			hasUI: true,
		});
		expect(interactive.mode).toBe("tui");
		expect(interactive.hasUI).toBe(true);
		expect(await interactive.ui.select("Trust", ["Trust"])).toBeUndefined();
		expect(await interactive.ui.confirm("Trust", "Continue?")).toBe(false);

		const print = createProjectTrustContext({ cwd: "/tmp/project", mode: "print", hasUI: false });
		expect(print.mode).toBe("print");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			print.ui.notify("offline", "warning");
			expect(error).toHaveBeenCalledWith("warning: offline");
		} finally {
			error.mockRestore();
		}
	});
});

describe("resolveProjectTrusted", () => {
	it("trusts a cwd with no project resources", async () => {
		const root = temp();
		const trusted = await resolveProjectTrusted({
			cwd: root,
			trustStore: new ProjectTrustStore(join(root, "agent")),
			projectTrustContext: createProjectTrustContext({ cwd: root, mode: "print", hasUI: false }),
		});
		expect(trusted).toBe(true);
	});

	it("reuses a stored decision and otherwise fails closed without a UI choice", async () => {
		const root = temp();
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".ti-trader"), { recursive: true });
		writeFileSync(join(cwd, ".ti-trader", "settings.json"), "{}\n");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const trustStore = new ProjectTrustStore(agentDir);
		trustStore.set(cwd, true);
		expect(
			await resolveProjectTrusted({
				cwd,
				trustStore,
				projectConfigDirName: ".ti-trader",
				projectTrustContext: createProjectTrustContext({ cwd, mode: "print", hasUI: false }),
			}),
		).toBe(true);

		const other = join(root, "other");
		mkdirSync(join(other, ".ti-trader"), { recursive: true });
		writeFileSync(join(other, ".ti-trader", "settings.json"), "{}\n");
		expect(
			await resolveProjectTrusted({
				cwd: other,
				trustStore,
				projectConfigDirName: ".ti-trader",
				defaultProjectTrust: "ask",
				projectTrustContext: createProjectTrustContext({ cwd: other, mode: "print", hasUI: false }),
			}),
		).toBe(false);
	});

	it("honors always/never defaults and a UI Trust choice", async () => {
		const root = temp();
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".ti-trader"), { recursive: true });
		writeFileSync(join(cwd, ".ti-trader", "settings.json"), "{}\n");
		const trustStore = new ProjectTrustStore(join(root, "agent"));
		const printContext = createProjectTrustContext({ cwd, mode: "print", hasUI: false });
		expect(
			await resolveProjectTrusted({
				cwd,
				trustStore,
				projectConfigDirName: ".ti-trader",
				defaultProjectTrust: "always",
				projectTrustContext: printContext,
			}),
		).toBe(true);
		expect(
			await resolveProjectTrusted({
				cwd,
				trustStore,
				projectConfigDirName: ".ti-trader",
				defaultProjectTrust: "never",
				projectTrustContext: printContext,
			}),
		).toBe(false);

		const asked = createProjectTrustContext({ cwd, mode: "interactive", hasUI: true });
		asked.ui.select = async () => "Trust";
		expect(
			await resolveProjectTrusted({
				cwd,
				trustStore,
				projectConfigDirName: ".ti-trader",
				defaultProjectTrust: "ask",
				projectTrustContext: asked,
			}),
		).toBe(true);
		expect(trustStore.get(cwd)).toBe(true);
	});
});
