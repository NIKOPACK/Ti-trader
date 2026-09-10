export const LIVE_ADAPTER_LIMITATIONS = [
	"Offline adapter contracts are not live/testnet certification; no externally verified evidence is recorded",
	"Exchange permissions, market filters and availability must still be checked at submission",
] as const;

export const CLOSE_USES_POSITION_SNAPSHOT = "Close uses the matching position snapshot as an explicit base quantity";

export const ALGO_ORDER_RETRY_PARAMS: readonly Record<string, unknown>[] = [
	{ ordType: "conditional" },
	{ trigger: true },
	{ trailing: true },
	{ ordType: "oco" },
];
