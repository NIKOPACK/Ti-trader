import { ALGO_ORDER_RETRY_PARAMS } from "./constants.ts";
import { experimentalLiveVenue } from "./experimental.ts";
import type { LiveVenueProfile } from "./types.ts";

const OKX_CLOSED_EXTRAS: readonly Record<string, unknown>[] = [
	{ ordType: "conditional", trigger: true },
	{ trigger: true },
	{ trailing: true },
	{ ordType: "oco", trigger: true },
];
const OKX_CANCELED_EXTRAS: readonly Record<string, unknown>[] = [
	{ ordType: "conditional", trigger: true },
	{ ordType: "trigger", trigger: true },
	{ trailing: true },
	{ ordType: "oco", trigger: true },
];

export const OKX_LIVE_VENUE: LiveVenueProfile = experimentalLiveVenue("okx", {
	password: "required",
	extraOrderListParams: () => ({
		open: ALGO_ORDER_RETRY_PARAMS,
		history: [],
		closed: OKX_CLOSED_EXTRAS,
		canceled: OKX_CANCELED_EXTRAS,
	}),
});
