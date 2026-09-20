import { type ExtensionContext, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	OcoPreflightResult,
	PlaceOrderType,
	PreparedOco,
	PreparedOrder,
	PreparedPlanConfirmation,
	ReferencePriceSource,
} from "@nikopack/ti-trading-engine";
import { type MenuKey, t, translate } from "./i18n.ts";
import type { TradingLanguage } from "./state.ts";

export type OrderReviewPlan =
	| { kind: "order"; plan: PreparedOrder }
	| { kind: "oco"; plan: PreparedOco; preflight: OcoPreflightResult };

export interface OrderReview {
	language: TradingLanguage;
	title: string;
	body: string;
}

const ORDER_TYPES: Record<PlaceOrderType, MenuKey> = {
	market: "orderReviewOrderMarket",
	limit: "orderReviewOrderLimit",
	stop: "orderReviewOrderStop",
	stop_market: "orderReviewOrderStopMarket",
	take_profit: "orderReviewOrderTakeProfit",
	take_profit_market: "orderReviewOrderTakeProfitMarket",
	trailing_stop_market: "orderReviewOrderTrailing",
};

const PRICE_SOURCES: Record<ReferencePriceSource, MenuKey> = {
	limit_price: "orderReviewLimitPrice",
	stop_price: "orderReviewStopPrice",
	ask: "toolAsk",
	bid: "toolBid",
	last: "orderReviewLast",
};

/** Display only the prepared snapshot; never fetch prices or calculate a second order plan. */
export function createOrderReview(
	prepared: OrderReviewPlan,
	context: {
		language: TradingLanguage;
		quoteCurrency: string;
		accountId?: string;
		usage: { used: number; reserved: number; limit: number };
		protectionStopPrice?: number;
		planReference?: { id: string; version: number; intentId: string };
		confirmation?: PreparedPlanConfirmation;
	},
): OrderReview {
	const { plan } = prepared;
	const { input, capabilityContext } = plan;
	const { language, quoteCurrency, usage, confirmation } = context;
	const unavailable = t(language, "orderReviewUnavailable");
	const number = (value: number | undefined, allowZero = false): string =>
		value !== undefined && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
			? String(value)
			: unavailable;
	const quote = (value: number | undefined): string => `${number(value)} ${quoteCurrency}`;
	const yesNo = (value: boolean): string => t(language, value ? "yes" : "no");
	const lines: string[] = [];
	if (confirmation?.requote) lines.push(t(language, "orderReviewUpdated"), "");
	const field = (label: MenuKey, value: string): void => {
		lines.push(`${t(language, label)}: ${value}`);
	};
	field("exchange", capabilityContext.exchangeId);
	// Runtime account identities are SHA-256 fingerprints, not credential substrings.
	field(
		"orderReviewAccount",
		context.accountId && /^[a-f0-9]{64}$/i.test(context.accountId) ? context.accountId : unavailable,
	);
	if (context.planReference) {
		field("orderReviewPlan", `${context.planReference.id} v${context.planReference.version}`);
		field("orderReviewPlanIntent", context.planReference.intentId);
		lines.push(t(language, "orderReviewPlanNotice"));
	}
	field("marketType", t(language, capabilityContext.marketFamily === "futures" ? "marketFutures" : "marketSpot"));
	field("colSymbol", input.symbol);
	field("colSide", t(language, input.side === "buy" ? "orderReviewBuy" : "orderReviewSell"));
	field(
		"colAmount",
		translate(language, "orderReviewBaseAmount", {
			amount: number(confirmation?.amount ?? input.amount),
			asset: input.symbol.split("/")[0] || unavailable,
		}),
	);

	if (prepared.kind === "order") {
		const { plan } = prepared;
		const { input } = plan;
		field("colType", `${t(language, ORDER_TYPES[input.type])} (${input.type})`);
		if (input.price !== undefined) field("orderReviewLimitPrice", quote(input.price));
		if (input.stopPrice !== undefined)
			field(
				input.type === "trailing_stop_market" ? "orderReviewActivationPrice" : "orderReviewStopPrice",
				quote(input.stopPrice),
			);
		if (input.trailingPercent !== undefined) field("colTrailing", `${number(input.trailingPercent)}%`);
		field("orderReviewNotional", quote(confirmation?.notional ?? plan.notional));
		if (capabilityContext.marketFamily === "futures") {
			field(
				"positionMode",
				t(language, capabilityContext.positionMode === "hedge" ? "positionHedge" : "positionOneWay"),
			);
			field("orderReviewPositionSide", input.positionSide ?? "BOTH");
			field(
				"orderReviewReduceOnly",
				`${t(language, "orderReviewRequested")}: ${yesNo(plan.reduceOnlyRequested)}; ${t(language, "orderReviewApplied")}: ${yesNo(plan.reduceOnlyApplied)}`,
			);
			field("orderReviewClosePosition", yesNo(input.closePosition === true));
		}
		// Keep the engine's final wire constraints verbatim, including future venue-specific additions.
		if (plan.exchangeConstraint) field("orderReviewConstraints", plan.exchangeConstraint);
	} else {
		const { plan, preflight } = prepared;
		field("colType", "OCO");
		field("orderReviewStopLoss", quote(plan.input.stopLossPrice));
		field("orderReviewTakeProfit", quote(plan.input.takeProfitPrice));
		field("orderReviewNotional", quote(confirmation?.notional ?? plan.observedNotional));
		field("orderReviewRiskNotional", quote(confirmation?.riskNotional ?? plan.riskNotional));
		field("colAvailable", `${number(preflight.balance.free, true)} ${preflight.balanceAsset}`);
		field("orderReviewRequiredBalance", `${number(preflight.requiredBalance)} ${preflight.balanceAsset}`);
		for (const warning of confirmation?.warnings ?? preflight.warnings) {
			if (warning.trim()) field("toolWarnings", warning);
		}
	}

	if (prepared.kind === "order") {
		for (const warning of confirmation?.warnings ?? []) {
			if (warning.trim()) field("toolWarnings", warning);
		}
	}
	field("orderReviewReference", quote(confirmation?.referencePrice ?? plan.referencePrice));
	const source = PRICE_SOURCES[prepared.kind === "order" ? prepared.plan.referencePriceSource : "last"];
	field("orderReviewSource", t(language, source));
	const referenceDate = new Date(plan.referenceTimestamp);
	field(
		"orderReviewReferenceTime",
		plan.referenceTimestamp > 0 && Number.isFinite(referenceDate.getTime())
			? referenceDate.toISOString()
			: unavailable,
	);
	if (context.protectionStopPrice !== undefined)
		field("orderReviewProtectionStop", quote(context.protectionStopPrice));
	field("orderReviewCountsQuota", yesNo(plan.countTowardsDailyLimit));
	field(
		"risk",
		translate(language, "orderReviewQuota", {
			used: number(usage.used, true),
			reserved: number(usage.reserved, true),
			limit: number(usage.limit),
			quote: quoteCurrency,
		}),
	);
	lines.push("", t(language, "orderReviewFeeUnknown"), t(language, "orderReviewEstimateNotice"));
	if (prepared.kind === "oco" && input.side === "buy") lines.push(t(language, "orderReviewOcoRiskNotice"));
	lines.push(t(language, "orderReviewConstraintNotice"), t(language, "orderReviewSubmitNotice"));
	return {
		language,
		title: translate(language, prepared.kind === "oco" ? "orderReviewOcoTitle" : "orderReviewTitle", {
			exchange: capabilityContext.exchangeId,
		}),
		body: lines.join("\n"),
	};
}

export class OrderReviewPanel implements Component {
	private readonly review: OrderReview;
	private readonly theme: Theme;
	private readonly rows: () => number;
	private readonly list: SelectList;
	private offset = 0;
	private pageSize = 1;
	private maxOffset = 0;
	private canSubmit = false;

	constructor(review: OrderReview, theme: Theme, rows: () => number, done: (confirmed: boolean) => void) {
		this.review = review;
		this.theme = theme;
		this.rows = rows;
		this.list = new SelectList(
			[
				{ value: "cancel", label: t(review.language, "orderReviewCancel") },
				{ value: "confirm", label: t(review.language, "orderReviewConfirm") },
			],
			2,
			getSelectListTheme(),
		);
		this.list.onSelect = (item) => done(item.value === "confirm" && this.canSubmit);
		this.list.onCancel = () => done(false);
	}

	render(width: number): string[] {
		if (width <= 0) {
			this.canSubmit = false;
			this.list.setSelectedIndex(0);
			return [];
		}
		const rows = Math.max(1, this.rows() - 2);
		const content = [
			...wrapTextWithAnsi(this.theme.bold(this.theme.fg("warning", this.review.title)), width),
			"",
			...wrapTextWithAnsi(this.review.body, width),
		];
		const kb = getKeybindings();
		const selected = this.list.getSelectedItem()?.value;
		// SelectList owns navigation; wrap both action labels instead of truncating them in narrow terminals.
		const actions = (["cancel", "confirm"] as const).flatMap((value) => {
			const label = t(this.review.language, value === "cancel" ? "orderReviewCancel" : "orderReviewConfirm");
			const lines = wrapTextWithAnsi(`${selected === value ? "> " : "  "}${label}`, width);
			return selected === value ? lines.map((line) => this.theme.fg("accent", line)) : lines;
		});
		const hint = wrapTextWithAnsi(
			`${kb.getKeys("tui.select.pageUp").join("/")} / ${kb.getKeys("tui.select.pageDown").join("/")}: ${t(this.review.language, "orderReviewScroll")}`,
			width,
		);
		this.canSubmit = actions.length + 2 <= rows;
		if (!this.canSubmit) {
			this.list.setSelectedIndex(0);
			content.unshift(...wrapTextWithAnsi(t(this.review.language, "orderReviewResize"), width), "");
		}
		const footer = !this.canSubmit
			? []
			: actions.length + hint.length + 2 < rows
				? ["", ...actions, ...hint]
				: actions;
		this.pageSize = Math.max(1, rows - footer.length - (rows > 1 ? 1 : 0));
		this.maxOffset = Math.max(0, content.length - this.pageSize);
		this.offset = Math.min(this.offset, this.maxOffset);
		const progress =
			rows > 1
				? [
						truncateToWidth(
							`[${this.offset + 1}-${Math.min(content.length, this.offset + this.pageSize)}/${content.length}]`,
							width,
						),
					]
				: [];
		return [...content.slice(this.offset, this.offset + this.pageSize), ...progress, ...footer];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
		else if (kb.matches(data, "tui.select.pageDown"))
			this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
		else this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

export async function showOrderReview(
	ctx: ExtensionContext,
	review: OrderReview,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return false;
	if (ctx.mode !== "tui") return ctx.ui.confirm(review.title, review.body, { signal });
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const finish = (confirmed: boolean): void => {
			signal?.removeEventListener("abort", abort);
			done(confirmed);
		};
		const abort = (): void => finish(false);
		const panel = new OrderReviewPanel(review, theme, () => tui.terminal.rows, finish);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) queueMicrotask(abort);
		return Object.assign(panel, { dispose: () => signal?.removeEventListener("abort", abort) });
	});
}
