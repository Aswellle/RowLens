# RowLens 决策记录（ADR）

按时间顺序登记。修改既有决策时新增条目，不删除旧条目。

## ADR-001：React + TypeScript strict + Vite，不使用大型 UI 组件库

来源：`docs/02-architecture.md`。理由：UI 状态与可访问性交互易于组织，
构建产物为纯静态文件，无服务端。样式使用原生 CSS + CSS variables。

## ADR-002：IndexedDB 作为行级临时存储

来源：`docs/02-architecture.md`。数据库名 `rowlens-local`，版本 1；store：
`datasets`（keyPath `id`）、`rows`（compound key `[datasetId, rowIndex]`）、
`importErrors`。React state 永远不持有全量行数据。接受浏览器配额差异，
配额错误必须以 `STORAGE_QUOTA_EXCEEDED` 单独处理并触发清理。

## ADR-003：Papa Parse 仅用于 CSV/TSV；JSONL 自建有界行流 parser

来源：`docs/02-architecture.md`。JSONL 使用 `File.stream()` +
`TextDecoder`（`{ stream: true }`）分块解码，缓冲区只保留未完成的当前行，
最大行长 5 MiB（`MAX_JSONL_LINE_BYTES`，待实测调整）。

## ADR-004：列值一律字符串，不做隐式类型转换

来源：PRD FR-02 与数据契约 §4。`00123` 保持 `00123`，日期文本原样保留。
排序为稳定 UTF-16 字符串排序；缺失值两种方向都排最后。

## ADR-005：源文件只读；清洗规则为可序列化管线配置

来源：PRD FR-05。清洗步骤只有 `id`/类型/参数/enabled/名称；结果通过重算
派生，导出只写新文件（默认 `-cleaned` 后缀）。

## ADR-006：Node 基线 `>=22.12.0`，本地开发用 Node 24 LTS

（2026-10-25，Phase 0）路线图写"Node 22 LTS"；实施日 22 与 24 均为活跃
LTS，本机为 v24.19.0，vitest 5.0.5 的 engines 为
`^22.12.0 || ^24.0.0 || >=26.0.0`。`package.json` engines 定
`>=22.12.0`，CI 矩阵跑 22 + 24。

## ADR-007：Phase 0 锁定的工具版本

（2026-10-25，实测 `npm view`）vite 8.3.5、@vitejs/plugin-react 6.1.2、
react/react-dom 19.3.1、typescript 7.0.2（latest 主线）、vitest 5.0.5、
prettier 3.9.10、@types/react(-dom) 19.3.0。全部精确版本（无 `^`），
lockfile 已提交。若 typescript 7 与后续加入的工具链（如 react-virtual 的
类型或 worker 类型）不兼容，回退到 typescript 5.x 最新维护版并在此登记。

## ADR-008：`papaparse` 与 `@tanstack/react-virtual` 延迟到各自 Phase 安装

（2026-10-25，Phase 0，更新于 Phase 1）工作协议禁止未使用的依赖。`@tanstack/react-virtual` 3.14.22 已随 Phase 1 接入并在此补记；`papaparse` 5.7.0 已随导入管线接入（见 ADR-015）。

## ADR-009：`test:unit` 脚本直接为 `vitest run`

（2026-10-25，Phase 0）测试文档 §5 曾写 `npm run test:unit -- --run`（假设
watch 脚本 + 附加参数）。为避免 CI 参数歧义，脚本本身定义为一次性运行，
`test:watch` 才是交互模式。

## ADR-010：Phase 0 的"契约测试"范围 = 类型契约 + 类型级断言 + 纯函数单测

（2026-10-25，Phase 0）路线图要求"定义解析/导出契约测试"，但解析器与导出
器在 Phase 2/5 才实现。Phase 0 落地为：数据模型与 Worker 消息的
discriminated union 定义（`src/features/**`），配结构锁定单测（消息判别
字段、终态消息集合、错误码目录、列 schema 派生纯函数）。解析器行为夹具
（quoted-newlines、BOM、UTF-8 chunk 边界等）属 Phase 2/5 的测试范围。

## ADR-011：Vite 构建前先跑 `tsc --noEmit`

（2026-10-25，Phase 0）Vite 只转译不做完整类型检查（见技术参考文档），
因此 `build` 脚本为 `tsc --noEmit && vite build`，`typecheck` 单独可跑。
tsconfig 在 strict 基础上追加 `noUncheckedIndexedAccess`、
`exactOptionalPropertyTypes`、`noUncheckedSideEffectImports`、
`noImplicitOverride`。

## ADR-012：导入管线 = 流式分块（内存）+ Worker（主线程）+ 批次 ACK 背压（三者缺一不可）

（2026-10-25，Phase 1 设计时锁定，Phase 2 实现）Papa Parse 的 chunk/step
流式解析与 Web Worker 解决的是不同问题：分块限制瞬时内存峰值（不必把整份
文件读成字符串），Worker 减少主线程阻塞（解析不冻结 UI）。仅靠其中任何一个
都不满足 PRD FR-01 与架构 §7。Phase 2 实现必须同时满足：

1. Worker 内以 chunk 模式驱动 Papa Parse（CSV/TSV）与自建 line streaming
   （JSONL），单批上限 `ROW_WRITE_BATCH_SIZE = 500` 行；
2. Worker 发出 `BATCH` 后暂停解析，等待主线程 IndexedDB 持久化成功并回
   `ACK(batchSeq)` 才继续——生产者快于存储时不形成无界消息队列；
3. 取消幂等，过期 `jobId` 的消息一律忽略（`ImportTerminalMessage` 后到达
   的同 job 消息不得覆盖新状态）。

## ADR-013：TanStack Virtual 只负责渲染虚拟化；查询与内存边界由架构承担

（2026-10-25，Phase 1）`@tanstack/react-virtual` 3.14.22 接入。它是 headless
渲染虚拟化，不会自动解决查询算法或内存问题：搜索/筛选/排序仍按契约
（literal 匹配、稳定排序、缺失值末位）先算出可见 `rowIndex` 列表，组件只
接收该列表和有界 `valueAt` 读取器；全量数据永不进入 React state。

Phase 1 已用两级测试固化该边界：组件测试断言 DOM 行数与数据量无关
（5000 行数据 < 60 个 row 节点）；E2E 在真实 Edge 上复验，并曾当场抓到
workspace grid 隐式 `auto` 行高导致容器被内容撑开、5001 行全部渲染的真实
布局 bug——证明"DOM 行数与 viewport 相关而非总记录数"必须用测试断言，
不能凭感觉认为虚拟化自动生效。

## ADR-014：导入期间的主线程写穿缓存

（2026-10-26）Worker 的每个 BATCH 本就要路过主线程写入 IndexedDB；`InMemoryDataset`
把同一批数据追加进一个模块级、列序紧凑的镜像（React state 之外），网格通过
`getCell(rowIndex, columnIndex)` 同步读取。内存上界受 `MAX_FILE_BYTES`（100 MiB）
约束；当查询 worker（后续步骤）就位后，网格读取将改为游标窗口读取，缓存随之
退役。此为过渡设计，不宣称适用无上限文件。

## ADR-015：Papa Parse 5.7.0 安装与 chunk 模式行为差异

（2026-10-26）papaparse 5.7.0 作为生产依赖安装（ADR-008 补记）。实现时发现并
处理了两个 chunk 模式的实际行为：(1) 文件以换行结尾时 chunk 模式会产出一个
`[""]` 幻影空记录（非 chunk 模式不会）——session 扣留末尾空记录并在完成时按
文件末字节判定真伪；(2) `parser.abort()` 后不保证回调 complete——session 在
abort 时主动进入终态。两者均有测试锁定。

## ADR-016：查询在 worker 中按窗口扫描执行；无 Worker 环境降级到同引擎主线程

（2026-10-26）查询协议每条消息带 `queryId`；query worker 用共享 repository 的
`getAll` 窗口读取（而非保持游标跨 await——挂起的游标会让事务自动提交）喂数据
给与降级路径完全相同的引擎。客户端新查询自动取代旧查询（对旧 id 发 CANCEL、
旧结果按 superseded 结算、晚到消息按 queryId 忽略）。匹配索引受
`QUERY_MATCH_LIMIT`（200k）约束，超限显式提示、绝不静默截断。无模块 Worker 的
环境走 `runLocalQuery`（同窗口读取 + 快路径：无谓词无排序时直接用 finalize 的
行数生成全量索引）。样本数据集也写入 IndexedDB 走同一条查询路径。

## ADR-017：deleteDataset 按 finalize 行数直删；事务内禁止 await

（2026-10-26）实测发现两处违反 IndexedDB 事务规则/性能雷区并修复：(1) 在事务
回调之间 `await` 会让事务自动提交，后续请求落在死事务上——删除改为单事务内
同步发起全部请求；(2) 索引游标逐键删除在 fake-indexeddb 下是平方级（5000 行
41 秒）。由于行的复合键是 `[datasetId, rowIndex]` 且 `ready` 数据集的 rowCount
精确描述键范围，改为直接按键删除；未 finalize 的数据集仍走游标兜底。

## ADR-018：清洗 = 可序列化配置的单趟行变换，嵌入查询管线执行

（2026-10-26）清洗步骤是纯数据（trim / remove-empty-rows / remove-duplicates /
select-columns，含 enabled 与作用范围），经 JSON 往返可复现相同结果。执行上不做
独立的"清洗 worker"：查询引擎增加可选 transform 钩子，在搜索/筛选命中之后、排序
键采集之前应用（排序与幸存索引反映清洗后的值），worker 与本地降级在**同一趟数
据扫描**内完成查询+清洗并返回逐步影响摘要——避免对数据集的第二次全量扫描。
"全部列"作用域解析为管线该位置的有效列（select-columns 会收窄后续步骤）；
去重键为 JSON 编码的精确值元组（首见保留、无哈希碰撞风险），比较规则 exact/
trimmed 由用户选择。原始 IndexedDB 行永不修改；select-columns 同时收窄网格展示
列（与手动隐藏列正交）。禁用步骤跳过但保留配置；影响计数在后台重算完成前保留
旧值并显示 Recomputing…。

## ADR-019：导出 = 流式序列化 + 保存器抽象；回退下载受独立字节上限

（2026-10-26）导出分三层：纯编码（必要引号、双引号转义、CRLF、OWASP 前缀检测
=, +, -, @, tab, CR 含空白/控制字符遮蔽；safe 模式加 `'` 前缀并计数，raw 不改动
值）、流式序列化器（有界 chunk、行/防护单元格/字节统计）、保存器抽象。保存器
优先 File System Access writable（真流式、无 Object URL；用户关掉选择器视为取消
静默收场），否则回退内存聚合下载——受 `EXPORT_FALLBACK_MAX_BYTES`（150 MiB）独立
上限约束，超限拒绝并给出说明而非尝试分配；Object URL 仅在 close 时创建、延迟
revoke（EXPORT_URL_REVOKE_DELAY_MS）。取消与写错误一律 abort 保存器且绝不声称已
保存。范围语义：filtered = 当前视图行序（含查询排序）；all = 全部记录过清洗管线
（"完整数据的清洗版本"，与产品简报一致）。E2E 以 headless 无保存选择器为由在测试
中移除 showSaveFilePicker 走下载路径并断言下载文件字节内容。另：Papa 的
UndetectableDelimiter 是提示级信息（回退逗号即我们的默认），不再计为 malformed。
