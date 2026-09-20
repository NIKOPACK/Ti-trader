# Ti 代码质量分析方法

调查时间：2026-09-20。范围：ISO/IEC 与 IEEE 标准、Google 工程规范、Stryker/CodeQL/Biome/fast-check 官方文档，对照本仓库现有门禁与 `trading-engine` 近期缺陷。目标是选出**能检出本仓库真实缺陷类别**的方法，不是通用质量仪表盘。

未覆盖：CAST/Sonar 商业评分、圈复杂度排行、覆盖率百分比门禁。这些指标不预测本仓库正在修的 admission / CAS / TTL 类错误。

## 结论

对本仓库，代码质量分析应按**缺陷类别**分层，不要用单一分数。ISO/IEC 25010:2023 给出产品特性清单；对本交易核，只盯四项：功能正确、fail-safe、可恢复、安全。[ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html)

推荐立刻用的栈（按信号从高到低）：

1. **保持现有静态门 + 不变量回归**（已有，是地板）。
2. **对着变更读周围不变量**（已有 `/review`，固化为方法，不是再加工具）。
3. **缺口导向的覆盖查看**（只看没跑到的分支，不对 `%` 设门）。
4. **只对 `trading-engine` / `trading-risk` 做变异测试**（看 surviving mutants，不当 KPI）。
5. **只对状态不变量做属性测试**（TTL、revision、未知结果不释放 quota）。
6. **CodeQL `javascript-typescript` default setup**（补数据流/CWE，不替代 4/5）。

具体例子：确认窗口里把 `riskRevision` 写成第二次 `inspect()` 的 generation。Biome 和 `tsgo` 都过；行覆盖也会标绿，因为那一行执行了。能抓住它的是：读 `journal.prepare()` 之后的 CAS 契约、断言「begin 用的是 prepare 后的 generation」、以及把「改成错误 generation」当成突变后测试必须失败。[Google Testing Blog: coverage 不保证断言正确](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)；[Jia & Harman, mutation adequacy](https://ieeexplore.ieee.org/document/5487526/)

## 质量模型：用哪些特性

ISO/IEC 25010:2023 产品模型有九项特性。对本仓库的映射：

| 特性 | 对本仓库 | 用什么分析 |
|---|---|---|
| Functional correctness | 准入、journal、CAS、TTL | 不变量测试、对抗审查、变异、属性测试 |
| Safety / fail-safe | 过期、pause、unknown 不重发 | 故障注入回归（已有 combo-fault）、fail-closed 断言 |
| Reliability / recoverability | 重启只查询不 place | 恢复测试、execution journal 不变量 |
| Security | 密钥权限、模型无 bash/write | gitleaks、CodeQL、现有工具边界 |
| Maintainability | 次要 | Knip 一次清理即可，不当主门 |

ISO/IEC 5055:2021（CISQ/OMG ASCQM）把可靠性、安全、性能、可维护性落成可自动计数的 CWE。它测的是结构弱点计数，不是交易状态机是否满足 CAS。[CISQ / ISO 5055](https://www.it-cisq.org/standards/code-quality-standards/)；[OMG ASCQM](https://www.omg.org/spec/ASCQM/)

NASA/JPL Power of Ten 针对 C 飞行软件（禁堆分配、循环有静态上界、函数约 60 行）。TypeScript/Node 交易引擎不要当清单执行。可借鉴的只有：断言密度、警告当错误、控制流简单到能审。[Holzmann, IEEE Computer 39(6), 2006](https://doi.org/10.1109/MC.2006.212)；[作者 PDF](https://spinroot.com/gerard/pdf/P10.pdf)

## 已有门禁覆盖什么

仓库已经覆盖「能机械判定」的一层：

| 门 | 测什么 | 不测什么 |
|---|---|---|
| `biome check --error-on-warnings` | 语法/可疑模式/格式；Biome 声明 lint 找常见错误，不负责格式以外的语义 [Biome linter](https://biomejs.dev/linter/) | admission 契约、CAS generation |
| `tsgo --noEmit` | 类型可证明的错误。TypeScript 类型系统有意不健全，兼容性靠结构而非证明 [Type Compatibility](https://www.typescriptlang.org/docs/handbook/type-compatibility.html) | 运行时 revision 用错 |
| `check:pinned-deps` / `check:ts-imports` / shrinkwrap | 供应链与导入形状 | 行为 |
| `./test.sh` + 包内 vitest | 例举回归；TTL 边界已有用例 `engine.test.ts` | 未写到的 generation 组合 |
| `gitleaks` | 密钥进仓 | 运行时权限 |
| `trading-readiness` / release-gate | 发布证据工件 | 代码是否正确 |
| 静态审计 `docs/audit-report.md` | 架构与约束「代码表达了什么」 | 测试是否通过、交易所是否接受 |

缺口：Biome `suspicious.noExplicitAny` 为 `off`，而 `Agents.md` 禁止 `any`。类型纪律目前靠人工，不靠 lint。

## 方法 1：对着变更读周围不变量

Google 工程规范要求审查**每一行**，并看文件/系统上下文；只看 diff 附近几行会漏掉「四行补丁让 50 行函数不再成立」。审查测试时要问：代码坏了测试会不会失败。[What to look for](https://google.github.io/eng-practices/review/reviewer/looking-for.html)；[Standard of code review](https://google.github.io/eng-practices/review/reviewer/standard.html)

对本仓库的操作：

- 交易核 diff 用现有 `/review`（local / dirty tree）。
- 审查清单只问三件事：这条路径的 generation/TTL/reservation 契约是什么；确认窗口会不会覆盖 `journal.prepare()` 之后的值；失败时 adapter 是否被调用、quota 是否释放。
- 不把 nit/风格当阻塞。Google 的标准是：CL 整体改善 code health 即可合入，不追求完美。

## 方法 2：缺口导向的覆盖（不当门禁）

Google：覆盖率说明行被执行过，**不说明被正确断言**；更有意义的是「哪些行为完全没跑到」。他们明确反对为冲百分比而复制测试，并指出更好的断言质量手段是变异测试。[Code Coverage Best Practices, 2020-08-07](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)；[Ivanković et al., coverage at Google](https://storage.googleapis.com/gweb-research2023-media/pubtools/5172.pdf)

独立证据：Inozemtseva & Holmes 在大型 Java 系统上发现覆盖率与测试有效性相关很弱，**不应把覆盖率当质量目标**。[ICSE 2014](https://dl.acm.org/doi/10.1145/2568225.2568271)

操作：在 `packages/trading-engine` 用 vitest v8 coverage 看 `engine.ts` / `execution-journal.ts` / account-risk 的未覆盖分支。只处理「提交路径上完全没执行」的缺口。不对 monorepo 设 80%/90% 门。

命令（从包目录跑，以 vitest 源码 alias 为准）：

```bash
cd packages/trading-engine
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run --coverage src/engine.test.ts
```

（当前包未配 coverage；要跑需临时加 `@vitest/coverage-v8`，不要为了分数改 CI。）

## 方法 3：变异测试（只测交易核）

变异测试向程序注入小故障，看测试会不会失败。Jia & Harman：mutation adequacy score 衡量测试集发现故障的能力，强于「行有没有跑到」。[TSE 37(5), 2011](https://ieeexplore.ieee.org/document/5487526/)

Just 等人在 Defects4J 上表明：能杀死真实缺陷的测试也会杀死相应突变，且该关系**独立于覆盖率**；变异仍有固有局限（等价突变、成本）。[FSE 2014](https://dl.acm.org/doi/10.1145/2635868.2635929)

Google 工业实践：全量变异不划算；只对**变更行**生成少量突变、过滤无意义突变、把 surviving mutant 当审查发现。覆盖不足由覆盖分析报，变异只跑在已覆盖行上。[Petrović et al., Practical Mutation Testing at Scale, TSE 2022](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/)；[State of mutation testing at Google, ICSE-SEIP 2018](https://research.google/pubs/state-of-mutation-testing-at-google/)

StrykerJS 官方：mutation score = detected / (detected + undetected)；survived 表示测试没抓住这类故障。有 Vitest runner 与 TypeScript checker（类型错误突变标 `CompileError`，不计入分数）。[Stryker FAQ](https://stryker-mutator.io/docs/General/faq/)；[Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)；[TypeScript checker](https://stryker-mutator.io/docs/stryker-js/typescript-checker/)

操作：只 mutate `packages/trading-engine/src/**/*.ts` 与 `packages/trading-risk/src/**/*.ts`，排除 `*.test.ts`。看 HTML 报告里的 survived，补断言。不要对整个 monorepo 跑，不要把 score 写进 CI 门槛。

```json
{
  "testRunner": "vitest",
  "checkers": ["typescript"],
  "mutate": ["packages/trading-engine/src/**/*.ts", "!packages/trading-engine/src/**/*.test.ts"],
  "vitest": { "configFile": "packages/trading-engine/vitest.config.ts" }
}
```

## 方法 4：属性测试（只绑不变量）

fast-check：随机生成输入、对断言跑数百次、失败时缩小到最小反例。用来抓例举测试没写到的边界，不是替代现有用例。[fast-check 官方](https://fast-check.dev/docs/introduction/)

对本仓库只测能写成全称命题的契约，例如：

- 对任意 `0 ≤ Δt ≤ PREPARED_PLAN_TTL_MS`，unattended Paper 提交调用 adapter；对任意 `Δt > TTL`，不调用 adapter 且 reservation 为 0（已有边界用例，属性测试可填中间值）。
- `journal.prepare()` 之后 `begin()` 的 `riskRevision` 等于 prepare 后的 account-risk generation，不等于确认窗口里第二次 `inspect()`。
- 提交结果为 timeout/network 时，不释放 quota、不第二次 `placeOrder`。

不要对 LLM 工具层或 TUI 铺属性测试。

## 方法 5：CodeQL 数据流

CodeQL 把代码当数据跑查询，GitHub 默认查询针对漏洞与错误，语言含 TypeScript（`javascript-typescript`）。Default setup 即可，不必自写查询。[About code scanning with CodeQL](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)；[Supported languages](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/)

它补的是：注入、路径穿越、不安全正则、密钥泄漏一类 CWE。它不理解 `riskRevision` 该用哪一代。CI 已有 `gitleaks`，CodeQL 与之正交。

## 可选：Knip

Knip 找未使用的 export、文件、依赖。[knip.dev](https://knip.dev/) 这是可维护性，不是正确性。适合做一次清理，有稳定零噪声后再考虑进 `npm run check`。

## 怎么跑一轮（建议顺序）

对 `packages/trading-engine` + `packages/trading-risk` 的一次质量分析：

1. `npm run check` 与包内 vitest（地板）。
2. `/review`：读 prepare/confirm/begin 周围，不只读 diff。
3. 看覆盖缺口：提交路径上完全没执行的分支。
4. 若刚改了 admission/journal：对这两个包跑 Stryker，处理 survived。
5. 把新契约写成属性或例举回归（TTL、generation、unknown）。
6. 安全面用 CodeQL + 现有 gitleaks，不替代 1–5。
