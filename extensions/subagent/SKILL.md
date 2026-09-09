---
name: subagent
description: Isolated subagents for Ti. Children may propose_order; the parent must submit.
metadata:
  version: 0.1.0
---

# Subagent

Use `subagent` to delegate research to an isolated child process.

Modes:

- Single: `agent` + `task`
- Parallel: `tasks` array
- Chain: `chain` array, with `{previous}` for the prior report

Bundled agents: `researcher`, `scanner`, `reviewer`.

Children may use `calculate_indicators`, `evaluate_strategy`, `screen_markets`, `simulate_rule`, and `propose_order`. `propose_order` is not a fill. The parent must `check_order` then `buy`/`sell`. Paper/unattended: that parent call is the approval. Live/confirm: the operator confirmation box still appears.
