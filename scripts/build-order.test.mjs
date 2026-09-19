import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tradingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/trading-agent/package.json", import.meta.url), "utf8"),
);

function packageBuildIndex(script, packageName) {
	return script.indexOf(`cd ../${packageName} && npm run build`);
}

test("root builds triggers before trading-agent", () => {
	assert.ok(tradingAgentPackage.dependencies["@nikopack/ti-triggers"]);

	for (const scriptName of ["build", "build:trading"]) {
		const script = rootPackage.scripts[scriptName];
		const triggersIndex = packageBuildIndex(script, "triggers");
		const tradingAgentIndex = packageBuildIndex(script, "trading-agent");

		assert.notEqual(triggersIndex, -1, `${scriptName} must build triggers`);
		assert.notEqual(tradingAgentIndex, -1, `${scriptName} must build trading-agent`);
		assert.ok(triggersIndex < tradingAgentIndex, `${scriptName} must build triggers before trading-agent`);
	}
});
