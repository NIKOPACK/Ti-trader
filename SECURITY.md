# Security Policy

Ti is an AI trading agent that runs locally within the security boundary of the
user running it. It can place real orders with real money when live mode is
enabled, so please report security issues responsibly.

## Trust Model

Ti treats the local user account and files writable by that account as inside
the same trust boundary as the Ti process itself. Exchange API keys are stored
locally under `~/.ti-trader/agent/keys.json` with mode 600; model provider credentials
are stored under `~/.ti-trader/agent/` via the upstream pi auth mechanism. Protecting
those files from other local users or processes is the operating system's job,
not Ti's.

Reports that depend on an attacker already having local write access to the
user's home directory, workspace, shell startup files, environment, or Ti
configuration are not security vulnerabilities unless they demonstrate how Ti
grants that access or crosses an operating-system privilege boundary.

## In Scope

- Ti placing unintended live orders, bypassing the risk layer
  (`maxOrderNotional`, `maxDailyNotional`, `allowedSymbols`), or bypassing the
  live-order confirmation flow without the user disabling it.
- Ti exfiltrating exchange API keys or model credentials to a third party.
- Remote code execution or privilege escalation reachable without prior local
  access.

## Out of Scope

- Losses from trades the LLM decided to make within the configured risk limits
  (that is the product working as designed; use paper mode and tight limits).
- Prompt injection attacks via market data, repository files, or user input.
- Behavior of extensions or skills installed by the user.
- Exposed secrets that are third-party/user-controlled credentials.
- Issues caused by intentionally weakened configuration (e.g.
  `confirmLiveOrders: false`).

## Credential handling

Never commit exchange API keys, model provider tokens, private keys, or local
credential files to this repository. Use the smallest possible exchange
permissions and disable withdrawals. Remove or rotate a credential immediately
if it is exposed, including in an issue, pull request, log, or published
artifact. Public reports containing credentials should be taken down and
rotated before investigating the software defect.

## Reporting a Vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/NIKOPACK/Ti/security/advisories/new)
for this repository. Do not open a public issue for security-sensitive reports.

Include a description of the issue and its impact, steps to reproduce or a
proof of concept, the affected version or commit, and any known mitigations.
We will review reports and coordinate disclosure as appropriate.
