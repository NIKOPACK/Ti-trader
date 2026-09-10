import { describe, expect, it } from "vitest";
import { evaluateOrderCapability, getTradingCapabilities, TRADING_CAPABILITY_MATRIX } from "../capabilities.ts";
import { liveCapabilityMatrixRows, resolveLiveVenue, validateLiveVenueCredentials } from "./index.ts";

describe("live venue profiles", () => {
	it("keeps offline-contract live rows on Binance only", () => {
		expect(liveCapabilityMatrixRows().map((row) => row.id)).toEqual(["binance-spot", "binance-usdm"]);
		expect(TRADING_CAPABILITY_MATRIX.filter((row) => row.mode === "live").map((row) => row.exchangeId)).toEqual([
			"binance",
			"binance",
		]);
	});

	it("treats OKX and Bybit live as experimental without claiming order-list recovery", () => {
		for (const exchangeId of ["okx", "bybit"] as const) {
			const matrix = getTradingCapabilities({ exchangeId, mode: "live", marketFamily: "spot" });
			expect(matrix.profile).toBe("experimental");
			expect(matrix.orderTypes.market).toMatchObject({ status: "unknown", evidence: { level: "experimental" } });
			expect(matrix.queryOrderListByClientId.status).toBe("unsupported");
		}
	});

	it("uses the experimental profile for unknown ccxt ids", () => {
		const venue = resolveLiveVenue("kraken");
		expect(venue.id).toBe("kraken");
		expect(venue.liveCapabilities).toEqual([]);
		expect(venue.password).toBe("optional");
		expect(venue.probeOppositeWallet).toBeUndefined();
		expect(venue.placeNativeSpotOco).toBeUndefined();
	});

	it("requires an OKX passphrase only at live credential validation", () => {
		expect(() => validateLiveVenueCredentials("okx", { apiKey: "k", secret: "s" })).toThrow(/passphrase/);
		expect(() => validateLiveVenueCredentials("okx", { apiKey: "k", secret: "s", password: "p" })).not.toThrow();
		expect(() => validateLiveVenueCredentials("binance", { apiKey: "k", secret: "s" })).not.toThrow();
	});

	it("keeps Binance close-all and hedge wire mapping off OKX", () => {
		const input = {
			type: "stop_market" as const,
			side: "sell" as const,
			closePosition: true,
			reduceOnly: true,
			positionSide: "LONG" as const,
		};
		const binance = evaluateOrderCapability(
			{ exchangeId: "binance", mode: "live", marketFamily: "futures", positionMode: "hedge" },
			input,
		);
		const okx = evaluateOrderCapability(
			{ exchangeId: "okx", mode: "live", marketFamily: "futures", positionMode: "hedge" },
			input,
		);
		expect(binance.omitExchangeQuantity).toBe(true);
		expect(binance.omitReduceOnly).toBe(true);
		expect(okx.omitExchangeQuantity).toBe(false);
		expect(okx.omitReduceOnly).toBe(false);
	});

	it("asks for a passphrase on OKX and not on Binance", () => {
		expect(resolveLiveVenue("okx").password).toBe("required");
		expect(resolveLiveVenue("binance").password).toBe("unused");
		expect(resolveLiveVenue("bybit").password).toBe("optional");
	});
});
