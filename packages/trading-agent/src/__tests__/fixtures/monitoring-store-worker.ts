import { createFileMonitoringStore, ensureMonitoringScope } from "../../monitoring-state.ts";

const [path, worker] = process.argv.slice(2);
if (!path || !worker) throw new Error("Expected state path and worker identity");
const store = createFileMonitoringStore(path);
for (let index = 0; index < 20; index++) {
	store.transact((state) => {
		const entry = ensureMonitoringScope(
			state,
			{ mode: "paper", exchange: "okx", marketType: "spot", quoteCurrency: "USDT", accountId: "test-account" },
			Date.now(),
		);
		entry.orders.known.push({ id: `${worker}-${index}`, symbol: "BTC/USDT" });
	});
}
