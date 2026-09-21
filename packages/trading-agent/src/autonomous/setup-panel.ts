import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	type SettingItem,
	SettingsList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AccountRiskLimits, validateAccountRiskLimits } from "@nikopack/ti-trading-engine";
import { t } from "../i18n.ts";
import { TitledSelect } from "../settings-menu.ts";
import type { TradingLanguage } from "../state.ts";
import { errorMessage } from "../tools/format.ts";
import type { AutonomousModelChoice, AutonomousSetupAnswers } from "./setup.ts";

export interface AutonomousSetupPanelOptions {
	language: TradingLanguage;
	/** Prefiltered, auth-checked model candidates; index 0 is the suggested default. */
	models: AutonomousModelChoice[];
	modelIndex: number;
	objective: string;
	accountLimits: AccountRiskLimits;
	unattended: boolean;
	/** Display-only derived scope and runtime summaries. */
	accountLine: string;
	runtimeLine: string;
}

const numericLimitFields = [
	"maxGrossExposure",
	"maxNetExposure",
	"maxAssetExposure",
	"maxLeverage",
	"maxMarginUsagePct",
	"maxDailyLoss",
	"maxDrawdown",
	"maxDataAgeMs",
	"maxPriceDeviationPct",
	"minDepthRatio",
	"minLiquidationDistancePct",
	"minProtectionCoveragePct",
	"maxStopDistancePct",
] as const;
const booleanLimitFields = ["cancelEntriesOnBreach", "reduceOnBreach"] as const;

function onOff(language: TradingLanguage, value: boolean): string {
	return value ? t(language, "on") : t(language, "off");
}

/**
 * One-screen first-run setup. Scope and timing fields are derived, never asked for;
 * the operator only confirms the model, objective, hard limits and unattended approval.
 * Esc resolves undefined (cancelled); "create" resolves the collected answers.
 */
export class AutonomousSetupPanel implements Component {
	private readonly theme: Theme;
	private readonly ctx: ExtensionCommandContext;
	private readonly done: (result?: AutonomousSetupAnswers) => void;
	private readonly options: AutonomousSetupPanelOptions;
	private list: SettingsList;
	private modelIndex: number;
	private objective: string;
	private readonly limits: AccountRiskLimits;
	private unattended: boolean;

	constructor(
		theme: Theme,
		ctx: ExtensionCommandContext,
		done: (result?: AutonomousSetupAnswers) => void,
		options: AutonomousSetupPanelOptions,
	) {
		this.theme = theme;
		this.ctx = ctx;
		this.done = done;
		this.options = options;
		this.modelIndex = options.modelIndex;
		this.objective = options.objective;
		this.limits = { ...options.accountLimits };
		this.unattended = options.unattended;
		this.list = this.createList();
	}

	private language(): TradingLanguage {
		return this.options.language;
	}

	private approvalLabel(): string {
		return this.unattended
			? t(this.language(), "autonomousSetupApprovalYes")
			: t(this.language(), "autonomousSetupApprovalNo");
	}

	private riskSummary(): string {
		const limits = this.limits;
		return `gross ${limits.maxGrossExposure} · net ${limits.maxNetExposure} · dailyLoss ${limits.maxDailyLoss} · stop ${limits.minProtectionCoveragePct}%`;
	}

	private createList(selectId?: string): SettingsList {
		const language = this.language();
		const yes = t(language, "autonomousSetupApprovalYes");
		const no = t(language, "autonomousSetupApprovalNo");
		const list = new SettingsList(
			[
				{
					id: "account",
					label: t(language, "autonomousSetupAccount"),
					currentValue: this.options.accountLine,
					description: t(language, "autonomousSetupDesc"),
				},
				{
					id: "runtime",
					label: t(language, "autonomousSetupRuntime"),
					currentValue: this.options.runtimeLine,
				},
				{
					id: "model",
					label: t(language, "autonomousSetupModel"),
					currentValue: this.options.models[this.modelIndex]?.label ?? "",
					description: t(language, "autonomousSetupModelDesc"),
					submenu: (current, done) =>
						new TitledSelect(
							this.theme,
							t(language, "autonomousSetupModel"),
							t(language, "autonomousSetupModelDesc"),
							this.options.models.map((model) => ({ value: model.label, label: model.label })),
							current,
							(value) => done(value),
							() => done(),
						),
				},
				{
					id: "objective",
					label: t(language, "autonomousSetupObjective"),
					currentValue: this.objective,
					description: t(language, "autonomousSetupObjectiveDesc"),
					submenu: (current, done) =>
						this.textInput(
							t(language, "autonomousSetupObjective"),
							t(language, "autonomousSetupObjectiveDesc"),
							current,
							done,
						),
				},
				{
					id: "risk",
					label: t(language, "autonomousSetupRisk"),
					currentValue: this.riskSummary(),
					description: t(language, "autonomousSetupRiskDesc"),
					submenu: (_current, done) => this.riskList(done),
				},
				{
					id: "approval",
					label: t(language, "autonomousSetupApproval"),
					currentValue: this.approvalLabel(),
					description: t(language, "autonomousSetupApprovalDesc"),
					submenu: (_current, done) =>
						new TitledSelect(
							this.theme,
							t(language, "autonomousSetupApproval"),
							t(language, "autonomousSetupApprovalDesc"),
							[
								{ value: yes, label: yes },
								{ value: no, label: no },
							],
							this.approvalLabel(),
							(value) => done(value),
							() => done(),
						),
				},
				{
					id: "create",
					label: t(language, "autonomousSetupCreate"),
					currentValue: "",
					values: [t(language, "autonomousSetupCreate")],
				},
			],
			12,
			getSettingsListTheme(),
			(id, value) => this.onChange(id, value),
			() => this.done(),
		);
		if (selectId) list.selectItem(selectId);
		return list;
	}

	private rebuild(selectId?: string): void {
		this.list = this.createList(selectId);
	}

	private onChange(id: string, value: string): void {
		switch (id) {
			case "model": {
				const index = this.options.models.findIndex((model) => model.label === value);
				if (index >= 0) this.modelIndex = index;
				break;
			}
			case "objective":
				if (value.trim()) this.objective = value;
				break;
			case "approval":
				this.unattended = value === t(this.language(), "autonomousSetupApprovalYes");
				break;
			case "create":
				if (this.finish()) return;
				break;
			default:
				break;
		}
		this.rebuild(id);
	}

	private finish(): boolean {
		const language = this.language();
		const model = this.options.models[this.modelIndex];
		if (!model) {
			this.ctx.ui.notify(t(language, "autonomousSetupNoModels"), "error");
			return false;
		}
		if (!this.unattended) {
			this.ctx.ui.notify(t(language, "autonomousSetupApprovalRequired"), "warning");
			return false;
		}
		try {
			validateAccountRiskLimits(this.limits);
		} catch (error) {
			this.ctx.ui.notify(errorMessage(error), "error");
			return false;
		}
		this.done({
			model,
			objective: this.objective.trim(),
			accountLimits: { ...this.limits },
			unattendedConfirmed: true,
		});
		return true;
	}

	private riskList(done: (value?: string) => void): SettingsList {
		const language = this.language();
		const fieldDescription = t(language, "autonomousSetupRiskFieldsDesc");
		const items: SettingItem[] = [
			...numericLimitFields.map(
				(name): SettingItem => ({
					id: `risk-${name}`,
					label: name,
					currentValue: String(this.limits[name]),
					description: fieldDescription,
					submenu: (_current, innerDone) =>
						this.textInput(name, fieldDescription, String(this.limits[name]), innerDone),
				}),
			),
			...booleanLimitFields.map(
				(name): SettingItem => ({
					id: `risk-${name}`,
					label: name,
					currentValue: onOff(language, this.limits[name]),
					description: fieldDescription,
					values: [t(language, "on"), t(language, "off")],
				}),
			),
		];
		return new SettingsList(
			items,
			Math.min(items.length, 12),
			getSettingsListTheme(),
			(id, value) => this.onRiskField(id, value),
			() => done(),
		);
	}

	private onRiskField(id: string, value: string): void {
		const name = id.slice("risk-".length);
		if ((booleanLimitFields as readonly string[]).includes(name)) {
			this.limits[name as (typeof booleanLimitFields)[number]] = value === t(this.language(), "on");
			return;
		}
		const parsed = Number(value);
		const allowsZero = name.startsWith("min");
		if (!Number.isFinite(parsed) || (allowsZero ? parsed < 0 : parsed <= 0)) {
			this.ctx.ui.notify(t(this.language(), "autonomousSetupInvalidNumber"), "error");
			return;
		}
		this.limits[name as (typeof numericLimitFields)[number]] = parsed;
	}

	private textInput(title: string, description: string, value: string, done: (value?: string) => void): Component {
		const input = new Input();
		input.setValue(value);
		input.onSubmit = done;
		input.onEscape = () => done();
		const theme = this.theme;
		return {
			render: (width) =>
				width <= 0
					? []
					: [
							...wrapTextWithAnsi(theme.bold(theme.fg("accent", title)), width),
							...wrapTextWithAnsi(description, width),
							"",
							...input.render(width),
						].map((line) => truncateToWidth(line, width)),
			handleInput: (data) => input.handleInput(data),
			invalidate: () => input.invalidate(),
		};
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const language = this.language();
		return [
			...wrapTextWithAnsi(this.theme.bold(this.theme.fg("accent", t(language, "autonomousSetupTitle"))), width),
			...wrapTextWithAnsi(this.theme.fg("muted", t(language, "autonomousSetupDesc")), width),
			"",
			...this.list.render(width),
		].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
