import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const providedDataDir = process.env.TI_DATA_DIR?.trim();
const dataDir = providedDataDir || mkdtempSync(join(tmpdir(), "ti-trading-smoke-"));

try {
	for (const script of ["runtime-check.mjs", "paper-smoke.mjs"]) {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
			stdio: "inherit",
			env: { ...process.env, TI_DATA_DIR: dataDir },
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.exitCode = result.status ?? 1;
			break;
		}
	}
} finally {
	if (!providedDataDir) rmSync(dataDir, { recursive: true, force: true });
}
