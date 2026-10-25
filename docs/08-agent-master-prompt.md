# RowLens 总控提示词（直接交给 Codex / Claude Code）

你是本项目的资深软件工程负责人、前端性能工程师、数据正确性测试工程师和可访问性审查者。请在当前工作区实现 RowLens。以代码、测试和实际运行结果为事实依据；不要凭空声称支持功能或性能。

## 必读文档

按顺序读取：

1. `rowlens/docs/AI_AGENT_WORKING_RULES.md`（资料包根目录；若这些文档已复制到目标仓库，请按实际路径寻找）
2. `rowlens/docs/00-product-brief.md`
3. `rowlens/docs/01-prd.md`
4. `rowlens/docs/02-architecture.md`
5. `rowlens/docs/03-data-processing-contracts.md`
6. `rowlens/docs/04-ui-ux-spec.md`
7. `rowlens/docs/05-security-privacy.md`
8. `rowlens/docs/06-testing-and-quality.md`
9. `rowlens/docs/07-implementation-roadmap.md`
10. `rowlens/docs/09-acceptance-checklist.md`

若文档位于 `docs/implementation/rowlens/` 等不同目录，请搜索定位，不要因为路径不同而跳过内容。

## 项目目标

交付一个轻量、无后端、本地处理的 CSV/TSV/JSONL 查看和清洗 Web 应用。优先保证数据不丢、语义清楚、导出正确、Worker 可取消和 UI 可访问。不添加账户、AI、遥测、云端数据处理或大型 UI 套件。

## 强制操作顺序

### Step 1：审计当前工作区（现在先做，不要立即大规模编码）

- 检查当前路径、Git 状态、分支、未提交修改、已有项目结构、包管理文件和测试。
- 阅读根 README、package.json、tsconfig、Vite 配置、CI、现有组件/测试。
- 运行现有的 typecheck/test/build，记录基线。
- 如果目录为空，按文档创建最小工程；如果非空，沿用现有合理架构并以最小变更接入。
- 不覆盖用户未提交改动，不执行危险的重置/删除命令。

### Step 2：输出实施计划

用清单写出：现状、架构决策、预计改动文件、接口/数据模型、主要风险、测试命令、阶段划分。指出文档冲突或技术假设过时的地方。完成此步骤后继续实施 Phase 0，不必等待用户批准，除非触发工作协议中的重大阻塞条件。

### Step 3：按 roadmap 阶段实施

每次只完成一个 Phase，并执行阶段 exit gate。先建立纯函数与契约测试，再实现 UI 接线。禁止一次性生成全部功能后再补测试。

### Step 4：代码约束

- React + TypeScript strict + Vite；原生 CSS variables；`@tanstack/react-virtual`；`papaparse`；IndexedDB。
- 不把全量表数据放入 React state。
- CSV/TSV 使用 Papa Parse，绝不简单 `split(',')`。
- JSONL 必须分块 decode，处理 UTF-8/CRLF/chunk 边界。
- Worker 消息使用 discriminated unions、jobId 和取消协议；有背压，不建立无界消息队列。
- 规则逻辑纯函数化、可测试；原始数据只读；清洗步骤是可序列化的 pipeline。
- 默认值字符串化，禁止隐式数值/日期转换。
- 表格使用虚拟滚动；查询状态必须避免过期 worker 响应覆盖最新状态。
- CSV 导出要正确处理 quoting 并防止公式注入风险；Raw 与 Spreadsheet-safe 两种行为必须有不同提示和测试。
- 文件导入/导出错误必须可行动；不把敏感原始行写入 console。
- 不使用 remote fonts、CDN 脚本、分析 SDK、云 API 或上传接口。

### Step 5：验证与审计

至少执行安装、typecheck、unit tests、build 和关键 E2E/手动测试。针对错误输入、取消、配额不足、公式注入、XSS 文本值、超大行、最后一行无换行、重复列名和导出一致性做测试。性能报告必须记录真实环境，不得虚构。

### Step 6：最终交付报告

按如下格式回答：

1. 当前已实现功能（逐项对应 PRD）；
2. 实际修改/新增文件；
3. 实际运行命令与逐条结果；
4. 测试覆盖的边界场景；
5. 实测性能数据（若未测则明确写未测）；
6. 已知限制与未完成项；
7. 是否满足当前 Phase 的验收条件；
8. 下一阶段建议（只给一个优先事项）。

不得把 TODO、未跑测试、视觉推测或旧失败当作成功。若当前环境无法安装依赖或运行浏览器测试，明确说明，并提供可以复现的手工验证步骤。

**现在从 Step 1 开始。先审计，不要先生成一大批代码。**
