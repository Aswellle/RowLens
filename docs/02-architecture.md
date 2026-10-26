# RowLens 架构与技术栈

## 1. 设计目标

- 依赖少、构建快、可在普通开发电脑上测试。
- 数据层与 UI 分离，清洗规则独立可测。
- 大文件处理通过分批、背压、IndexedDB 和虚拟化控制峰值内存。
- 没有服务器端组件或远端 API。

## 2. 技术栈决策

| 层 | 选择 | 理由 / 限制 |
|---|---|---|
| 应用 | React + TypeScript strict | UI 状态和可访问性交互容易组织；不使用大型 UI 框架 |
| 开发与构建 | Vite | 开发反馈快，静态产物简单；Node 版本要求在实际安装时复核 |
| 表格虚拟化 | `@tanstack/react-virtual` | Headless、样式完全自控；需要团队自己实现 grid 表现和可访问性 |
| CSV / TSV | `papaparse` | 正确处理引用字段、分隔符、流式 chunk 与 parse errors |
| JSONL | 自建行流 parser，使用 `File.stream()`/`TextDecoder` | 规则简单；测试 chunk 边界、CRLF 和 UTF-8 多字节字符 |
| 数据存储 | IndexedDB（浏览器原生 API） | 支持分批写入与异步游标，不引入服务端数据库；需处理配额和清理 |
| 样式 | 原生 CSS + CSS variables | 控制视觉、减少构建链与设计系统依赖 |
| 图标 | 少量打包内 SVG/轻量图标集 | 不从 CDN 加载图标；图标需有文本替代或 aria-label |
| 测试 | Vitest + Testing Library + Playwright（最小配置） | 分别覆盖纯逻辑、交互和关键浏览器流程；安装后评估依赖重量 |
| 包管理 | npm + `package-lock.json` | 用户机器通用；锁文件提交仓库 |

### 依赖添加原则

先使用上表列出的核心依赖。不要引入 Redux、全套 UI Kit、Tailwind、日期库、数据框架、图表库、数据库 WASM、Docker 等，除非需求变化经过 ADR 审批。避免为极小功能新增库。

## 3. 数据流

```text
File input / drag-drop
        |
        v
File validation + import job coordinator (main thread)
        |
        v
Import Worker
  CSV/TSV -> Papa Parse chunk parser
  JSONL/NDJSON -> TextDecoder streaming line parser
        |
        | batches + progress + errors; worker waits for ACK (backpressure)
        v
IndexedDB repository (temporary dataset records)
        |
        +--------------------+
        |                    |
        v                    v
Query Worker             Cleaning pipeline
(IDB cursor scans)       (pure transformation rules / row scans)
        |                    |
        +---------> result row indexes + step summaries
                             |
                             v
                  React virtualized grid
                             |
                             v
                 Export Worker / stream writer
                             |
                             v
                      Download output
```

## 4. 目录建议

```text
rowlens/
  public/
  src/
    app/                 # app shell, routes if later needed, global error boundary
    components/          # drop zone, toolbar, grid, column menu, dialogs, notices
    features/
      import/            # import controller, format detection, worker protocol
      dataset/           # types, schema, IndexedDB repository
      query/              # search/filter/sort query config and worker
      cleaning/          # serializable steps + pure functions
      export/             # CSV serializer, formula safety modes, save/download
      settings/           # theme and non-sensitive UI preferences
    workers/
      import.worker.ts
      query.worker.ts
      export.worker.ts
    styles/              # tokens.css, base.css, components.css
    test/                # fixtures and test helpers
  docs/
  tests/e2e/
  package.json
  package-lock.json
  tsconfig.json
  vite.config.ts
```

Agent may adjust the exact tree if the scaffold requires it, but must preserve these boundaries. Avoid a flat `utils.ts` file containing unrelated business logic.

## 5. Data model

```ts
type DatasetId = string;
type RowIndex = number;
type ColumnId = string;

type ColumnDefinition = {
  id: ColumnId;           // unique, stable; never use display name as primary key
  label: string;          // user-facing; may duplicate
  sourceKey?: string;     // JSONL key if applicable
  sourceIndex?: number;   // CSV/TSV source position
};

type StoredRow = {
  datasetId: DatasetId;
  rowIndex: RowIndex;     // zero-based data record index, separate from physical line number
  values: Record<ColumnId, string | null>;
};

type DatasetMetadata = {
  id: DatasetId;
  format: 'csv' | 'tsv' | 'jsonl' | 'ndjson';
  fileName: string;       // local display only; never transmit
  byteSize: number;
  status: 'importing' | 'ready' | 'cancelled' | 'failed';
  createdAt: number;
  lastTouchedAt: number;
  rowCount: number;
  columns: ColumnDefinition[];
  parseErrorCount: number;
  importWarnings: ImportWarningSummary[];
  schemaVersion: 1;
};
```

`StoredRow.values` 统一把可显示值规范化为字符串。CSV / TSV 默认不推断数字或日期。JSONL 的 primitive 转为显示字符串；嵌套 object/array 以稳定 JSON 文本表示。必须在 schema/转换层处理 `null`、缺失值和重复键。

## 6. IndexedDB 设计

- Database name: `rowlens-local`；版本升级必须可重复、可测试。
- Object stores: `datasets`（keyPath `id`）；`rows`（compound key `[datasetId, rowIndex]`，并建 datasetId 可用的复合索引以便按范围读取）；`importErrors`（如实现单独存储，以 datasetId + physicalLineNumber 唯一标识）；`cellEdits`（v2，keyPath `datasetId`，单元格编辑覆盖层，见 ADR-027）；`pipelines`（v3，keyPath `datasetId`，清洗步骤配置，见 ADR-030）；`views`（v4，keyPath `datasetId`，查询视图：搜索/筛选/排序/隐藏列，见 ADR-031）。三个配置类 store 都是"每数据集一条"，与导入行严格分离：保存配置不写任何行，删除数据集时在同一事务里级联删除。
- 每批写入建议从 500 条开始，通过真实基准调整；禁止将整份文件放进一个长期 transaction。
- 数据集状态只有在所有批次成功写入并 finalize 之后才改为 `ready`。
- Worker 与主线程的 IDB 访问需要明确模块所有权。推荐所有 row write 由 repository 统一处理；若 Query Worker 自己读取 IDB，须共享 schema/version 常量并测试版本升级行为。
- 清理策略：启动时发现 `importing` 且过期、`cancelled`/`failed` 的数据集则尝试删除；用户移除数据集时显示清理状态。TTL 建议 24 小时，作为代码常量并配测试。
- 所有 IDB 错误都通过 typed error 传回 UI；`QuotaExceededError` 必须单独处理。

## 7. Worker 协议

每条消息必须含 `jobId` 和 `type`，如 `IMPORT_START`、`BATCH`、`ACK`、`PROGRESS`、`IMPORT_DONE`、`CANCEL`、`ERROR`。为每种消息定义 TypeScript discriminated union。

- `BATCH` 包含有限数量记录；建议每批最多 500–1000 条或有明确字节上限，实际以基准决定。
- Worker 发出批次后暂停解析，等待 main thread 持久化成功后 ACK；这样避免 producer 快于 IndexedDB，形成无界消息队列。
- cancel 要幂等；过期 job 的消息必须忽略，避免关闭旧文件后晚到消息覆盖新状态。
- Worker 报错要包含稳定错误码、可理解的说明和可选物理行号；不要把整行敏感原文传入日志。

## 8. 查询与清洗的内存约束

- React state 只保留数据集元信息、查询配置、清洗步骤、可视行切片和状态；不得存整份表。
- Query Worker 从 IndexedDB 游标扫描数据，执行字面搜索、过滤和稳定排序；向 UI 分页/批次返回匹配 rowIndex。
- 对全量操作显示进度与取消；新查询开始时取消旧查询或使用 queryId 忽略旧结果。
- 排序必须稳定并给出资源上限。如果匹配索引数量超过经过验证的上限，清晰提示，不得偷偷截断结果。
- 清洗结果采用配置步骤重算；对重复检测使用哈希桶/集合时，需考虑 collision 后的原值比较，不能只相信哈希。
- 首版可以用一组 rowIndex 结果作为过滤索引，但要用目标数据集基准观察内存。若实测不合格，再考虑分页索引或 SQLite/WASM；不可预先引入重型方案。

## 9. 错误处理

错误类型至少包含：`UNSUPPORTED_FORMAT`、`FILE_TOO_LARGE`、`PARSE_FAILED`、`PARTIAL_PARSE_ERRORS`、`STORAGE_QUOTA_EXCEEDED`、`IMPORT_CANCELLED`、`EXPORT_TOO_LARGE_FOR_FALLBACK`、`EXPORT_FAILED`、`QUERY_FAILED`、`DATASET_NOT_FOUND`。

UI 文案需说清：发生了什么、数据是否已导入/保存、下一步能做什么。不展示堆栈给普通用户；开发模式可输出精简诊断。

## 10. ADR 记录

- ADR-001：React + TypeScript + Vite，因快速交付且生态成熟；不使用大型 UI 组件库。
- ADR-002：IndexedDB 做临时行存储，避免全量数据驻留 React 内存；承认本地存储配额差异并提供清理。
- ADR-003：Papa Parse 仅用于 CSV/TSV；JSONL 自建 bounded line parser，避免把 JSONL 全部读成一条字符串。
- ADR-004：列值默认字符串；不自动类型转换以免静默改变数据。
- ADR-005：源文件只读；清洗规则是管线配置，结果通过新文件导出。
