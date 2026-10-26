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

## ADR-020：性能基准首测结论与两处即时修正

（2026-10-26）按测试文档 §4 跑 P1/P2/P3 基准（数据与复现见
docs/performance-results.md）。基准过程直接促成两处产品修正：

1. **无谓词全量视图快路径（worker 对齐本地路径）**：250k 行数据集的初始
   视图此前也走全表扫描并被 200,000 匹配上限拦截——上限本意约束"带谓词的
   查询结果"，不该挡住数据集的完整视图。快路径由 finalize 行数直接生成
   索引，同时消除一次无谓扫描。
2. **查询 busy 标记补全**：排序/列筛选/Reset/防抖搜索提交此前不置 busy，
   排序"耗时"被测成表头翻转毫秒级——修正后才得到真实的 P3 排序 5.0s。
   基准脚本因此先于用户发现了一个会误导用户的反馈缺口。

基准同时量化了已知瓶颈：全表字面搜索的逐格大小写折叠（P3 64.7s，排序趟
仅 5.0s 佐证）、写穿缓存内存放大（~6.5×）、导出与导入的近线性扩展。缓解
方案（小写化缓存、搜索列范围限制、内存剖析）登记为后续候选，未实施。

## ADR-021：生产产物网络审计与逐项豁免

（2026-10-26）`scripts/audit-network.mjs` 随 `npm run build` 扫描 dist 全部
js/css/html：禁止 fetch/XHR/sendBeacon/WebSocket/EventSource/远程动态
import/远程 script 标签及非本机 URL。全部豁免按库上下文或裸域固定并注释
依据——Vite modulepreload polyfill 的 fetch（仅取回本站模块）、Papa Parse
自带的网络输入模式分支（RowLens 只传 File，bundle 内死代码）、以及仅作为
标识符/许可证文本出现的域名（w3.org 命名空间、react.dev 错误消息字符串、
github.com 许可证头）。应用级网络调用无法借道这些豁免。实施中发现并修正：
Papa 许可证头在 bundle 中被换行拆分导致上下文正则不命中；审计域提取不含
路径，豁免按域粒度声明。

## ADR-022：查询 worker 的小写化值缓存

（2026-10-26）搜索/筛选的逐格 `toLocaleLowerCase` 是 P3 基准的绝对瓶颈
（64.7s；排序趟仅 5.0s 佐证）。worker 现按数据集维护折叠值缓存
（行 → 列 → 小写值），首趟惰性构建、跨查询复用，数据集重导入（rowCount
变化）即失效。引擎通过可选 `foldedAt` 钩子取折叠值，无钩子时退回逐格折叠
——语义单一实现，仅取值路径分叉。实测（P2 专项）：首趟 12.4s 建缓存，
重复搜索 2.6s（4.7×）；代价是每格一份小写副本的内存（与写穿缓存同量级，
仍受 100 MiB 导入上限约束）。同时交付：查询取消按钮（StatusLine busy 时
可取消，引擎批次间生效）、单元格 Copy 按钮（Clipboard API + 非安全上下文
execCommand 回退，hover/键盘可达）、360–1440px 四档视口 E2E。

## ADR-023：网格 roving tabindex 与查询结果归约纯函数

（2026-10-26）网格采用 roving tabindex：任一时刻恰有一个单元格可 Tab 到达，
方向键/Home/End/PageUp/PageDown 在可见窗口内移动焦点并经
`scrollToIndex` 把目标行滚入虚拟窗口，点击单元格同步接管焦点（否则
tabIndex=0 的 grid 容器会吞掉点击焦点）。行表头（记录号）暂不在漫游范围内，
已在 README 记录。

同时把查询结果到视图状态的映射抽成纯函数 `reduceQueryOutcome`：此前
cancelled 分支直接返回原状态，`queryBusy` 永不清除——**取消后 Cancel 按钮
会永久滞留**（真实缺陷，基准与手测均未覆盖，新增回归测试锁定）。归约函数
统一 done/limit/failed/cancelled/superseded 五态规则并保持 superseded 时
引用不变以避免无谓重渲染。

## ADR-024：网格矩形选区、行表头语义与剪贴板格式

（2026-10-26）选区坐标采用**视图位置**（当前可见结果列表的行位置 + 可见数据
列下标），列 `-1` 表示记录表头。这样选区天然与搜索/排序/隐藏列后的视图一致，
无需映射回原始行号；代价是结果集变化后旧矩形不再描述同一批记录，因此
`visibleIndices` 引用变化即收敛为活动单元格。

三条契约写在纯函数层（`src/features/grid/selection.ts`），可脱离 DOM 测试：

1. **端点落在行表头即整行**：`boundsOf` 检测任一端点列 < 0 就横向铺满全部
   可见列。行表头是**选择器而非数据**，复制时永不贡献值（否则会把
   "Record 12" 混进用户数据）。这也让从表头往下拖保持整行，而不是退化成
   单列矩形。
2. **读取时钳制**：`boundsOf` 以当前 `rowCount`/`columnCount` 收紧矩形，
   不信任状态里的旧坐标。缩小的结果集或隐藏列不可能让复制越过可见范围。
3. **TSV + CRLF**：制表符分隔、行分隔用 CRLF（Excel/Sheets 无需导入向导），
   含制表符/换行/引号的字段按 RFC 4180 加引号并双写引号。值取自
   `valueAt`，即用户所见（含清洗 trim 后的显示值），复制不会绕到原值后面。

**上限 100,000 单元格**：超限明确拒绝并提示改用 Export CSV，绝不静默截断
（截断的粘贴结果比报错更难发现）。上限按单元格数而非字节数，便于解释。

**剪贴板两条路径**：键盘 Ctrl/Cmd+C 走同步 `copy` 事件写 `clipboardData`
（无需权限、不受非安全上下文限制），选区工具条按钮走异步 Clipboard API 并
回退 `execCommand`；两者共用同一序列化函数，避免内容分叉。

**拖拽边缘自动滚动**：虚拟化只保留屏内行，若不做自动滚动，拖拽选区永远
无法超出当前窗口。实现为每帧按指针进入边缘区的深度计算 1–16px 的有界步长
（`edgeScrollDelta`，纯函数测试覆盖），滚动后重新取指针下的单元格，使选区
跟随内容而非鼠标坐标。帧循环经 ref 调用最新闭包，否则会一直使用拖拽开始
那一帧的窗口与选区状态。

**已知取舍**：无单元格编辑、无 Ctrl+click 多区间选择（区域选择足以覆盖
"复制一块去别处"的主路径）；选区不参与导出范围（导出仍以筛选视图/全量为准）。

## ADR-025：单元格编辑作为内存覆盖层

（2026-10-26）编辑**不写回**任何持久层：覆盖层是
`Map<rowIndex, Map<columnId, string>>`，网格、查询引擎、清洗管线和导出全部
在读取时叠加它。原始 IndexedDB 行、源文件、以及"源文件只读"的承诺因此都不
需要额外机制来保证——不存在写路径。代价是刷新即丢失，这一点在 README 与
CHANGELOG 明确写出，不假装是持久编辑。

关键设计点：

1. **按 columnId 而不是显示位置索引**：隐藏列、`select-columns` 清洗步骤、
   重新排序都不会把编辑挪到别的列。
2. **两种"空"必须区分**：`undefined` = 无覆盖（回落到存储值），`''` = 用户
   把单元格清空。`EditChange` 的 `before`/`after` 存的是**覆盖层的值**（
   `null` 表示无覆盖），因此连续撤销会沿编辑历史逐步回退，而不是一次跳到
   存储值。`EditInput` 额外带 `displayed` 与 `stored`：用户把原值重新输入
   一遍时覆盖项被移除，不会留下一个"看起来没改但标记为已编辑"的幽灵项。
3. **查询覆盖层先于一切**：引擎在搜索/筛选/排序/清洗之前套用编辑，所以
   编辑后的值能被搜到、能被排序、也能被清洗步骤看到。worker 的折叠值缓存
   （ADR-022）存的是编辑前的值，因此被编辑的单元格绕过缓存直接折叠。
4. **上限 5,000 单元格**：覆盖层随每个查询请求一起 structured clone，无上限
   会让每次按键都变成大对象复制。超限返回明确的拒绝文案，网格关闭编辑器
   并播报原因，不静默丢弃草稿。
5. **撤销栈在视图状态里**：`applyEdits` 返回新状态而非修改，`Reset edits`
   也是一条可撤销的批量动作。撤销/重做是纯函数，测试不需要 DOM。
6. **焦点契约**：编辑器内部的 mousedown 不再冒泡成单元格选择（否则点击输入
   框会把草稿提交并抢走焦点）；焦点初始化只在编辑器**打开**时执行一次，
   否则每敲一个字符都会重置光标与选区。
7. **文档级快捷键**：Ctrl/Cmd+Z 绑定在 window 上，但在 input/textarea 内让位
   给浏览器原生撤销，避免破坏正在输入的文本。

**已知取舍**：无多单元格粘贴、无持久化、编辑与清洗步骤不共享撤销栈（清洗是
配置，编辑是数据，两者语义不同）。

## ADR-026：剪贴板粘贴的解析、平铺与裁剪

（2026-10-26）粘贴与复制对称：复制写出 TSV，粘贴读入 TSV，因此"复制一块
到别处"在 RowLens 内部闭环。解析与计划拆成纯函数
（`src/features/grid/paste.ts`），网格只决定起点，父层只提交结果。

四条规则：

1. **解析按 RFC 4180 的引号语义**：引号字段可含制表符、换行和双写引号。
   行尾的单个换行被丢弃——几乎每个来源都以换行结尾，把它当成空行会多粘
   一行空数据；块**内部**的空行保留。
2. **单格选区向外溢出，多格选区被平铺**：与电子表格一致。选中 1 格粘贴
   2×2 块 → 向右下铺开；选中 3×2 粘贴单值 → 六格全填。平铺让"把一列填成
   同一个值"不需要重复粘贴。
3. **越界一律裁剪并计数，不换行续写**：粘贴永不写入用户当前看不见的行。
   裁剪数量通过 `role="status"` 播报（`N row(s) outside the view were not
   pasted`），不静默丢弃。
4. **一次粘贴 = 一条撤销记录**：网格把整块作为 `GridCellEdit[]` 交给
   `commitEdits`，`applyEdits` 一次写入并只压一个批次，因此 Ctrl+Z 一次撤
   整块而不是逐格退。上限检查同样按批次去重计数，超限则整批拒绝并说明。

**焦点即锚点**：粘贴起点取自 `document.activeElement` 对应的单元格，而不是
roving 状态。focus 事件与 paste 可能在同一 tick 到达，此时状态还没重渲染，
用状态会让粘贴落到上一格。

**编辑器内不拦截**：编辑器打开时把 paste 留给 input，否则用户往单元格里粘
一段文本会被当成区域粘贴。

**已知取舍**：不解析 CSV 的逗号分隔（剪贴板约定是 TSV，逗号分隔会把
"1,050" 拆成两格）；无"仅粘贴值/格式"选项；粘贴不扩展行数（没有追加新记
录的语义）。
