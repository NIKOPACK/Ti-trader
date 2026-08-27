import type { TradingMode } from "./state.ts";

export interface TradingArgs {
	help: boolean;
	version: boolean;
	print: boolean;
	mode?: TradingMode;
	exchange?: string;
	noExtensions: boolean;
	verbose: boolean;
	/** Initial message (positional args joined). */
	message?: string;
}

export function parseTradingArgs(argv: string[]): TradingArgs {
	const result: TradingArgs = {
		help: false,
		version: false,
		print: false,
		noExtensions: false,
		verbose: false,
	};
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				result.help = true;
				break;
			case "-v":
			case "--version":
				result.version = true;
				break;
			case "-p":
			case "--print":
				result.print = true;
				break;
			case "--verbose":
				result.verbose = true;
				break;
			case "--no-extensions":
				result.noExtensions = true;
				break;
			case "--mode": {
				const value = argv[++i];
				if (value !== "paper" && value !== "live") {
					throw new Error(`--mode must be "paper" or "live", got "${value ?? ""}"`);
				}
				result.mode = value;
				break;
			}
			case "--exchange": {
				const value = argv[++i];
				if (!value) throw new Error("--exchange requires a ccxt exchange id, e.g. --exchange okx");
				result.exchange = value.toLowerCase();
				break;
			}
			default:
				if (arg.startsWith("--mode=")) {
					const value = arg.slice("--mode=".length);
					if (value !== "paper" && value !== "live") throw new Error(`--mode must be "paper" or "live"`);
					result.mode = value;
				} else if (arg.startsWith("--exchange=")) {
					result.exchange = arg.slice("--exchange=".length).toLowerCase();
				} else if (arg.startsWith("-")) {
					throw new Error(`Unknown option: ${arg} (see --help)`);
				} else {
					positional.push(arg);
				}
		}
	}

	if (positional.length > 0) {
		result.message = positional.join(" ");
	}
	return result;
}

export function printHelp(): void {
	console.log(`ti — AI trading agent CLI (built on the pi agent harness)

Usage: ti [options] [message...]

Options:
  --mode <paper|live>     Trading mode (default: from ~/.ti-trader/agent/trading.json, initially paper)
  --exchange <id>         ccxt exchange id, e.g. binance, okx (default: from config)
  -p, --print             Non-interactive: run once with the given message and exit
      --no-extensions     Do not load user extensions
      --verbose           Verbose output
  -h, --help              Show this help
  -v, --version           Show version

Trading commands (interactive mode):
  /language    Change TUI language (中文 / English)
  /balance     Account balances with valuation
  /positions   Holdings with entry price and PnL
  /orders      Open orders
  /trades      Order history
  /markets     Top markets by volume
  /mode        Show/switch paper|live
  /exchange    Show/switch exchange
  /risk        Risk limits and today's usage
  /exchange-login  Configure trading exchange API credentials

Plus the generic session commands (/model, /login, /new, /resume, /quit, ...).

Config: ~/.ti-trader/agent/trading.json (language: zh-CN or en-US)
API keys: ~/.ti-trader/agent/keys.json (or /exchange-login)
Model auth: /login → model provider (stored in ~/.ti-trader/agent/)
Exchange auth: /exchange-login → Binance（币安）/ OKX / Bybit
`);
}
