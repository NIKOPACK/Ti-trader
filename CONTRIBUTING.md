# Contributing to Ti

Thanks for your interest in contributing.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated output without understanding it is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically, and make sure it follows the rules there.

## Before You Open a PR

- Open an issue first for anything beyond a small fix, so the design can be discussed before you invest time.
- Keep PRs focused: one logical change per PR.
- Run `npm run check` and `./test.sh` locally; both must pass. `npm run check` is read-only; use `npm run format:fix` when you intend to rewrite formatting.
- Ti is a trading tool. Changes that weaken the risk layer, the paper-first default, or the live-order confirmation flow need a very strong justification.

## Commit Style

`{feat,fix,docs}[(scope)]: <message>` — informative and concise, no emojis.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
