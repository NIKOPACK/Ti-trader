# Trading release evidence reference

This reference is for maintainers deciding whether a candidate may enter a **limited, human-confirmed live pilot**. It does not approve unattended trading, publication or the use of an account. A passing script checks evidence consistency, not the truth of a human-authored observation.

## Generate isolated offline evidence

From the repository root:

```bash
node scripts/trading-readiness.mjs --report /tmp/ti-release-evidence/offline.json
```

The runner invokes the existing repository check and explicit risk, engine and agent test selectors. Child processes receive an allowlisted environment, a temporary home and a separate `TI_DATA_DIR`; provider credentials, custom endpoints, proxy variables and `NODE_OPTIONS` are not inherited. It does not build, publish, call a model or run the public-market smoke scripts.

The report contains the candidate Git revision, timestamps, suite exit codes and whether the checkout stayed clean. Failed runs return a nonzero exit code and retain their report. A dirty development tree can produce useful regression evidence, but that evidence cannot satisfy the release gate. Regenerate evidence from the reviewed, committed candidate.

CI runs this same command. Public-market smoke checks remain separate: a successful network smoke does not replace crash-recovery or persistence regressions.

## Verify an isolated package installation

Build the candidate first (`npm run build:trading`). Packing and installing are not publication. From the repository root, with a work directory **outside** the checkout:

```bash
node scripts/trading-package-install.mjs --report /tmp/ti-release-evidence/installation.json
```

The runner packs the risk, engine, agent and triggers packages, installs those tarballs into a temporary directory, and checks `ti --version`, `TI_DATA_DIR` isolation, default Paper mode and restart recovery of a durable reservation. It also saves and tracks a plan, appends an unapproved second version and research note, then verifies the exact evidence from a second process. A larger stored draft set exercises the 4 KiB nonauthoritative startup index. The installed plan/decision extensions must register their actual tools, commands and lifecycle hooks; a plan with no fills must remain insufficient evidence.

The probe does not invoke a model, submit orders or start monitoring. It does not publish, inherit `NPM_TOKEN`/`NODE_OPTIONS`, or use workspace links. If the packages are already packed, pass `--tarball-dir` and `--skip-pack`. Keep `--workdir` outside the repository if you need to inspect the install. Script-fixture results are not evidence that the candidate was independently installed.

## Collect a Paper soak

Use a dedicated data directory and the independently installed candidate, not the development workspace. Sample at least every ten minutes from the durable journal and Paper ledger:

```bash
export TI_DATA_DIR="$HOME/ti-candidate-data"
node scripts/trading-paper-soak.mjs --report /tmp/ti-release-evidence/soak.json --data-dir "$TI_DATA_DIR" --run --activity --install-dir /path/to/isolated-install
```

`--run` continues until SIGINT/SIGTERM. Restarting the collector against the same report increments `restartCount`. `--activity --install-dir /path/to/isolated-install` places a small Paper round-trip each interval using the installed package. `--expected-fault` marks an injected-fault sample; a later healthy sample is required. `--complete` is only for the final sample after seven observed days; a short or gappy run cannot be completed into valid evidence. If a sample gap exceeds ten minutes, start a new candidate soak. Do not concatenate records from different Git revisions.

## Evaluate a release manifest

Keep the manifest and its JSON artifacts in a private directory outside the checkout. Run:

```bash
node scripts/trading-release-gate.mjs /tmp/ti-release-evidence/evidence.json
```

Exit code `0` means all declared pilot prerequisites were accepted. Exit code `1` blocks the pilot and lists missing or inconsistent evidence. The current checkout must be clean and match the manifest revision. This command has no publication or trading side effects.

Manifest fields:

| Field | Required content |
| --- | --- |
| `schemaVersion` | `2` |
| `revision` | Full candidate Git commit hash |
| `versions` | Exact `risk`, `engine` and `agent` package version strings |
| `offline` | Artifact reference for the isolated runner report |
| `soak` | Artifact reference for the seven-day Paper observation record |
| `drills` | Artifact reference for recovery exercises |
| `installation` | Artifact reference for a clean package installation exercise |
| `liveCapabilities` | Artifact reference for externally verified Live submit/query/cancel/recovery paths |
| `pilotApproval` | Explicit maintainer review, limited pilot scope and Ed25519 signature |

An artifact reference is `{ "file": "offline.json", "sha256": "<64 lowercase hex characters>" }`. Paths are relative to the manifest directory. Absolute paths, traversal outside that directory, external symlinks, mismatched hashes and mismatched revisions are rejected. Compute hashes from the exact artifact bytes after writing them; for example, `shasum -a 256 /tmp/ti-release-evidence/offline.json` on macOS. Every artifact is a JSON object with its own `kind` and matching `revision`.

## Paper soak artifact

`kind` must be `paper-soak`, `mode` must be `paper`, and `schemaVersion` must be `2`.

| Field | Meaning |
| --- | --- |
| `dataDirIdentity` | `sha256:` plus the hex digest of the canonical Paper data directory. Do not record the path. |
| `startedAt`, `completedAt` | Canonical ISO UTC timestamps spanning at least seven days |
| `restartCount` | Positive integer, counted from actual controlled restarts |
| `activity` | `attempts`, `successes`, `failures` and `lastSuccessAt` for Paper round-trips |
| `samples` | Chronologically ordered observations, with no gap over ten minutes |

Each sample contains `at`, `duplicateSubmissions`, `lostUnresolvedRecords`, `unresolvedExecutions` and `healthy`. Counters must come from inspecting the journal and exchange/Paper ledger, not from assuming that a process exit was successful. Duplicate submissions and lost records must remain zero. Successful Paper round-trips set `activity: "succeeded"`. An intentionally injected fault may have `healthy: false`, `expectedFault: true` and outstanding unresolved executions. The last sample must be healthy with no unresolved executions.

The gate rejects an idle seven-day report. It requires at least seven successful Paper round-trips, matching sample-level `activity: "succeeded"` observations, one controlled fault, and a later healthy recovery sample.

Record a sample at startup and at completion as well as during the run. Keep no more than ten minutes between the declared bounds and their nearest samples. A process that was merely left open for seven days, a report with a week-long gap, or a compressed replay of historical dates does not constitute soak evidence. The gate cannot detect invented observations; maintainer review of source logs is mandatory.

## Recovery exercise artifact

`kind` must be `recovery-drills`. Include `completedAt` and `cases`, with exactly one successful entry for each:

```text
crash-before-send
accepted-before-crash
partial-fill
oco-partial-evidence
concurrent-recovery
storage-failure
transport-failure
monitor-restart
restore-from-backup
```

Each entry is `{ "name": "...", "passed": true, "observation": "..." }`. State what was interrupted, which durable evidence remained, and why another order was not submitted. Do not paste API keys, credentials, raw authenticated requests or account-identifying exchange responses into observations. Artifact hashes bind the report; they do not authenticate the reviewer. Reviewer identity is the Ed25519 signature on `pilotApproval`.

## Clean installation artifact

`kind` must be `package-install`. Include `completedAt`, `passed: true`, supported `nodeMajor`, and `versions` matching the manifest. `checks` must record successful `cleanInstall`, `cliVersion`, `isolatedDataDir`, `paperDefault`, `recoveryAfterRestart`, `continuityAfterRestart` and `evidenceTools` exercises. Older reports without the continuity and extension-registration evidence do not pass.

Use an isolated package installation, not a workspace whose aliases can hide missing published files. Inspect package contents and exact dependency versions. `scripts/trading-package-install.mjs` performs local pack and install only; it does not publish. Building remains a separate maintainer step. The offline readiness runner does not pack, install or soak.

## Live capabilities artifact

`kind` must be `live-capabilities` with `schemaVersion` `1`. Record `completedAt`, the CCXT version used during the observation, and `paths`.

Each path must include `exchange`, `marketFamily` (`spot` or `futures`), `positionMode`, `orderType`, `quoteCurrency`, `environment` (`testnet` or `live`), `submit`/`query`/`cancel`/`recovery` each equal to `passed`, `evidenceLevel: "externally-verified"`, and a non-secret `observation`. Mock adapter tests, `offline-contract` rows and `experimental` rows cannot satisfy this artifact. If no path is externally verified, the gate stays blocked; do not write a success-shaped placeholder.

`pilotApproval.exchange`, `pilotApproval.market` and `pilotApproval.quoteCurrency` must match at least one verified path. A verified Binance spot path does not approve Binance futures.

## Pilot approval

`pilotApproval` records `reviewer`, matching `revision`, `approvedAt`, `scope: "human-confirmed-live-pilot"`, `exchange`, `market`, `quoteCurrency`, a positive `maxNotional`, `withdrawalsDisabled: true`, `confirmEveryOrder: true`, and `signature`.

`signature` is `{ "alg": "ed25519", "keyId": "<id from scripts/release-reviewers.json>", "value": "<base64>" }`. The signature covers the canonical JSON of the approval fields (excluding `signature`) plus the candidate revision, schema version, package versions and every artifact `{file, sha256}` reference. Trusted public keys live in `scripts/release-reviewers.json`. An empty registry, unknown reviewer, revoked `keyId` or mutated payload fails closed.

To add a maintainer key: generate an Ed25519 key pair, store the private key outside the repository, and append `{ "id", "keyId", "publicKeyPem", "status": "active" }` with an SPKI `BEGIN PUBLIC KEY` PEM. Rotate by adding a new `keyId` and setting the old entry to `"status": "revoked"`. Do not commit private keys or PKCS8 `BEGIN PRIVATE KEY` material. Sign with `signApproval(approvalPayload(evidence), privateKeyPem)` from `scripts/release-approval.mjs` after the artifact hashes are written.

The cap is an explicitly approved limit, not a recommended investment size. Do not copy a sample cap into a real account without approval. Keep testnet or live credentials outside evidence artifacts. Approval of a pilot is not approval to publish npm packages, increase limits or disable confirmation. A passing gate with `assuranceLevel: "signed-active-verified"` still does not approve unattended trading.

## Current acceptance status

These gates are executable, but their existence is not completed release evidence. The working-tree implementation has **not** completed a seven-day activity soak, clean candidate installation or an authorized live pilot. Freeze a trading-safety candidate, then complete out-of-repo installation and continuous isolated Paper verification. Isolated Paper verification does not wait on `liveCapabilities` or signed `pilotApproval`; those still block a live pilot. Missing soak, installation, live-capability or signed-approval artifacts must continue to block live-pilot readiness; do not populate success-shaped placeholders to make the gate pass.
