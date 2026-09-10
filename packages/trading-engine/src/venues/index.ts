import type { ExchangeCredentials } from "../client-types.ts";
import { BINANCE_LIVE_VENUE } from "./binance.ts";
import { experimentalLiveVenue, missingApiKeyOrSecret } from "./experimental.ts";
import { OKX_LIVE_VENUE } from "./okx.ts";
import type { LiveVenueProfile, VenueCapabilityMatrixRow } from "./types.ts";

const KNOWN_LIVE_VENUES: Readonly<Record<string, LiveVenueProfile>> = {
	binance: BINANCE_LIVE_VENUE,
	okx: OKX_LIVE_VENUE,
	bybit: experimentalLiveVenue("bybit"),
};

export function resolveLiveVenue(id: string): LiveVenueProfile {
	return KNOWN_LIVE_VENUES[id] ?? experimentalLiveVenue(id);
}

export function liveCapabilityMatrixRows(): VenueCapabilityMatrixRow[] {
	return Object.values(KNOWN_LIVE_VENUES).flatMap((venue) =>
		venue.liveCapabilities.map((row) => ({ ...row, mode: "live" as const, exchangeId: venue.id })),
	);
}

export function validateLiveVenueCredentials(exchangeId: string, credentials: ExchangeCredentials): void {
	const missing = missingApiKeyOrSecret(exchangeId, credentials);
	if (missing) throw new Error(missing);
	const venue = resolveLiveVenue(exchangeId);
	if (venue.password === "required" && !credentials.password?.trim()) {
		throw new Error(`Live mode requires a passphrase for "${exchangeId}"`);
	}
}

export { BINANCE_CLOSE_ALL, BINANCE_HEDGE_REDUCTION } from "./binance.ts";
export { LIVE_ADAPTER_LIMITATIONS } from "./constants.ts";
export type {
	CredentialPasswordPolicy,
	LiveVenueProfile,
	VenueCapabilityMatrixRow,
	VenueLiveCapability,
	VenueWireMapping,
} from "./types.ts";
export { defaultWireMapping, venueWireContextFromOrder } from "./types.ts";
