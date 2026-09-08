import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { MarketViewData } from "./renderer.ts";
import { renderMarketChart } from "./renderer.ts";

export class MarketChartComponent implements Component {
	private expanded: boolean;
	private readonly data: MarketViewData;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: () => void;

	constructor(tui: TUI, theme: Theme, data: MarketViewData, done: () => void, expanded = true) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.done = done;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		return renderMarketChart(this.data, width, this.theme, this.expanded);
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "q") {
			this.done();
			return;
		}
		if (data === "e" || data === " ") {
			this.expanded = !this.expanded;
			this.tui.requestRender();
		}
	}

	invalidate(): void {}
}
