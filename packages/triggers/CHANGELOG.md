# Changelog

All notable changes to `@nikopack/ti-triggers` are documented in this file.

## [Unreleased]

## [0.1.1] - 2026-09-20

### Fixed

- Package `repository`, `homepage` and `bugs` now point at [NIKOPACK/Ti-trader](https://github.com/NIKOPACK/Ti-trader).
- The evaluator now returns an `unknown` evaluation with a reason for unsupported condition kinds instead of throwing a bare `TypeError` when unvalidated input reaches the public `evaluateCondition`/`transitionTrigger` APIs.
- `conditionSchema` and `triggerSchema` now validate trigger structure instead of accepting any value. The recursive condition schema is expressed as a JSON Schema definition referenced through `$ref`, and `triggerSchema.when` rejects structurally invalid conditions. `expiresAt` accepts any `Date.parse`-able string, matching `validateTriggerDefinition`.

## [0.1.0] - 2026-09-02

### Added

- Initial release: deterministic conditional trigger evaluation with fail-closed semantics, fact freshness windows, cross/change/stable_for conditions, `once`/`on_edge`/`while_true` policies with cooldown and expiry, and structural trigger validation.
