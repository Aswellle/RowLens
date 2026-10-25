# RowLens 分阶段实施计划

## 实施方式

严格按阶段执行；每一阶段可独立验证。禁止一次性并行实现 importer、清洗管线、导出器和 UI，因为它们共享数据契约且极易发生接口返工。

## Phase 0 — 仓库基线与设计锁定

### 任务

- 检查目标仓库与 Git 状态；无仓库时创建 Vite React TypeScript 最小工程。
- 选定 Node.js 22 LTS 的兼容版本并复核当前 Vite 官方要求；提交 `package-lock.json`。
- 建立 `docs/decisions.md` 或 ADR 目录，把 `02-architecture.md` 的关键决策登记。
- 定义数据模型、Worker 消息类型与解析/导出契约测试。
- 建立 CI 最小流程和格式化/类型检查脚本。

### Exit gate

可重复安装；`typecheck`、测试命令、生产构建脚本存在；数据契约没有关键歧义。

## Phase 1 — UI 骨架与样式系统

### 任务

- 实现 tokens、基础排版、空状态、文件信息条、toolbar、网格容器、响应式布局。
- 仅用合成示例数据驱动静态网格，先锁定交互结构与可访问性。
- 加载/空/错误/无搜索结果状态完整。
- 建立基础 E2E 测试，检查键盘可用和不同视口布局。

### Exit gate

用户能理解主路径；无真实文件处理前，UI 不得假装功能已工作。组件无大型 UI 套件依赖。

## Phase 2 — Import pipeline 与 IndexedDB

### 任务

- 实现 IndexedDB schema/repository 和 dataset 生命周期。
- CSV/TSV worker 使用 Papa Parse chunk parsing，批次写入 + ACK 背压。
- JSONL worker 做 bounded line streaming、UTF-8 stream decode、坏行分类。
- 实现取消、任务 ID、防竞态、进度和配额错误。
- 编写全部 parser contract tests 和 IDB 集成测试。

### Exit gate

样例夹具全部通过；任务取消、失败时不会暴露半成品；导入期间 UI 仍可操作。

## Phase 3 — 查询与虚拟网格

### 任务

- 实现 query worker 和 IndexedDB cursor 扫描。
- 实现全局 literal search、列筛选、稳定排序、隐藏列、行计数。
- 接入 TanStack Virtual，验证 DOM 行数量与 viewport 相关，而不是总数据量相关。
- 支持长值截断、复制、空结果和 clear all。

### Exit gate

查询契约通过；快切文件/筛选时没有过期状态覆盖；大样本页面不渲染全量行节点。

## Phase 4 — 清洗步骤引擎

### 任务

- 先写纯函数：trim、empty-row、dedupe、column selection。
- 设计 serializable `CleaningStep` 和 `PipelineRevision` 类型。
- pipeline 执行在 worker 内分批读取数据；进度、取消、错误与结果缓存有明确生命周期。
- UI 增加步骤添加/编辑/启停/删除/重置、影响计数与导出预览。

### Exit gate

清洗前后值可由测试精确验证；原始 IndexedDB rows 不变；Pipeline JSON 序列化后可复现相同结果。

## Phase 5 — CSV export 与安全模式

### 任务

- 实现 CSV escaping、稳定列/行顺序、Filtered vs All 导出。
- Spreadsheet-safe 与 Raw 模式分离并提示；加入 OWASP 风险样例。
- 大导出使用 file writer stream（受支持时），回退下载有明确大小限制。
- 处理取消、写入错误、Object URL 生命周期与文件名安全。

### Exit gate

导出结果用独立 parser 重新解析后与预期结果匹配；无静默截断；公式注入行为经过测试。

## Phase 6 — UX 打磨、可访问性与性能

### 任务

- 按 `04-ui-ux-spec.md` 调整视觉密度、层级、色彩、焦点、窄屏和暗色主题。
- 执行手动浏览器矩阵和性能基准；把实测结果写入 docs。
- 解决 P0/P1；记录其余已知限制。

### Exit gate

达到 `06-testing-and-quality.md` 的核心门槛；不能只凭“看上去流畅”判断性能。

## Phase 7 — Release candidate

### 任务

- 完成 README、LICENSE、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG。
- 创建合成 demo 文件和脱敏截图/GIF。
- 检查生产构建中无 CDN、分析 SDK 和数据上传代码。
- 用干净工作区安装、运行、构建并按验收清单走一遍。

### Exit gate

所有 P0/P1 关闭；支持矩阵和性能声明有证据；发布动作由用户明确授权。

## 推荐会话拆分

- Session A：Phase 0–1，架构锁与 UI 骨架。
- Session B：Phase 2，导入与存储；只修改 importer/dataset/test。
- Session C：Phase 3，查询与网格；先阅读数据契约，不重写 importer。
- Session D：Phase 4–5，纯逻辑测试优先，再 UI 接线。
- Session E：Phase 6–7，独立审计；优先找错误，不直接大规模重写。

新会话开始时附 `README.md`、本计划、数据处理契约和最近一次交接摘要。不要把整个历史聊天都当作可靠规格。
