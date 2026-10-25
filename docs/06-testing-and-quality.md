# RowLens 测试策略与质量门槛

## 1. 测试分层

1. 纯逻辑单元测试：格式检测、schema、清洗函数、CSV 导出与公式风险保护。
2. Parser contract tests：引用换行、特殊字符、UTF-8 chunk 边界、无效记录与空文件。
3. IndexedDB 集成测试：分批写入、游标、迁移、取消清理、配额错误模拟。
4. React 交互测试：空状态、导入进度、搜索/筛选、清洗步骤、导出选项、键盘操作。
5. Playwright E2E：真实浏览器打开 fixture、清洗、导出并校验下载内容。
6. 性能测试：合成的多行多列文件，记录机器、浏览器版本、大小、行数、耗时、峰值内存可用指标。
7. 手动兼容性测试：Chrome/Edge、Firefox、Safari 当前稳定版；在 Windows 11 和至少一个窄屏视口检查。

## 2. 测试夹具

所有夹具必须是合成数据，不能纳入用户真实数据。

- `basic.csv`：常规表头、引号、逗号。
- `quoted-newlines.csv`：引号字段包含逗号、双引号和换行。
- `duplicate-headers.csv`：空表头、重复表头、Unicode。
- `no-header.tsv`：无表头制表符数据。
- `bom-crlf.csv`：BOM + CRLF。
- `empty.csv`、`header-only.csv`、`trailing-newline.csv`、`no-final-newline.csv`。
- `malformed.csv`：字段数不匹配、畸形引号，应记录错误，不得静默丢字段。
- `basic.jsonl`：不同 schema、嵌套对象、null、Unicode。
- `invalid-lines.jsonl`：坏 JSON 行夹在有效记录之间。
- `multibyte-boundary.jsonl`：把 Unicode 字符放到 chunk 可能切分的位置。
- `long-line.jsonl`：超出最大行长度的记录。
- `formula-injection.csv`：公式危险前缀及空白/控制字符组合。
- `xss-values.csv`：`<script>`、`<img onerror=...>` 等只应当显示为文本。

## 3. 必测行为

### Import

- 文件取消、重复导入、快速连续选不同文件、导入期间点击移除。
- Worker 旧任务晚到消息不得覆盖新任务。
- IDB 写入失败后不能把 incomplete dataset 标为 ready。
- 无效 JSONL 行不阻断后续有效记录。

### Query / grid

- 搜索与筛选组合产生正确结果数量。
- 清除筛选后恢复原结果。
- 排序稳定，重复值保留原始相对顺序。
- 快速变更查询时旧 worker 结果不会覆盖新查询。
- 大量行只渲染少量 viewport nodes；页面滚动时没有全量 DOM。

### Cleaning

- Trim 只改首尾、不改内部空格。
- 空行定义与列作用范围符合文档。
- 去重保留第一条、键列模式和全行模式正确、哈希碰撞时仍比较原值。
- 启停/重排步骤产生可预测输出。
- 清洗结果不得改变存储中的原始记录。

### Export

- CSV 的逗号、换行、双引号转义正确。
- 过滤结果与全量导出行数区分清楚。
- 列选择顺序正确。
- Spreadsheet-safe 与 Raw 模式的差异有测试和 UI 说明。
- 取消、失败、Object URL 清理、无文件保存 API 回退路径可用。

### Accessibility

- 仅使用键盘完成导入到导出流程。
- 表头排序状态可被读屏识别。
- dialog 正确管理焦点、Escape 行为和焦点恢复。
- 文字对比度达到 WCAG AA 目标；缩放 200% 无关键操作丢失。

## 4. 性能基准（验收目标，不是未经验证的宣传）

建议基准机器：Windows 11、16 GB RAM、当前稳定版 Chrome/Edge。用脚本生成：

- P1：10 MB / 20k rows / 20 columns；
- P2：50 MB / 100k rows / 30 columns；
- P3（探索性）：100 MB / 250k rows / 40 columns。

记录导入总耗时、首次可用时间、搜索耗时、过滤耗时、排序耗时、导出耗时、失败/峰值内存可观测值。阈值在第一轮基准后写入 `docs/performance-results.md`，不能先写入 README 作为事实。起始目标是 P2 不出现 UI 长时间冻结，任务可取消，内存不会无界增长。

## 5. CI 要求

每次 PR 至少运行：

- `npm ci`
- `npm run typecheck`
- `npm run test:unit -- --run`（以实际脚本为准）
- `npm run build`

若安装 Playwright 浏览器开销过大，可在独立 CI job 中执行 E2E；不允许因本地资源不足而永久删除关键 E2E 覆盖。

## 6. 缺陷分级

- P0：数据丢失、导出内容错误、任何文件外传、源文件意外被覆盖、XSS/严重安全风险。
- P1：核心导入/清洗/导出不可用、结果静默截断、UI 主线程长时间冻结且无法取消。
- P2：明显 UX 错误、可访问性缺陷、特定非主流输入格式处理不当且无数据丢失。
- P3：视觉微调、非核心便利功能。

发布候选要求：无未解决 P0/P1；所有风险与已知限制公开记录。
