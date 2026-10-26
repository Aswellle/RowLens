# RowLens UI/UX 设计规范

## 1. 视觉方向

**关键词：Quiet Utility、Data-first、calm precision。** 看起来像高质量开发者工具，而不是营销型 SaaS Dashboard。界面要轻、信息密度高但不拥挤，避免大量彩色卡片、玻璃拟态、渐变装饰、过强阴影和无意义动画。

### 颜色系统（CSS variables）

使用中性色为主体、一个清晰的强调色。以下是设计起点，实施时用实际对比度验证，不是硬性品牌颜色：

- Light background: `#F7F8FA`
- Surface: `#FFFFFF`
- Primary text: `#19212B`
- Secondary text: `#5F6B7A`
- Border: `#DCE1E7`
- Accent: `#315EFB`（仅用于主要操作、选中态和焦点）
- Success/warning/error 使用低饱和背景 + 足够对比文字，不以颜色作为唯一状态符号。
- Dark theme 用独立 token 定义，避免简单反转颜色；确保 table hover、focus、selection、disabled 均可区分。

### 字体与排版

- 系统字体栈优先，不从远程加载字体。
- 正文 14–16px；表格单元格 13–14px；主标题 22–28px；元信息 12–13px。
- 行高、间距使用 4px 基础网格；表格行建议 36px，密度切换暂不进入 MVP。
- 对数值字段使用 tabular numerals；长文件名和单元格用 ellipsis，提供复制或完整值查看。

## 2. 主页面信息架构

### 桌面布局

```text
┌────────────────────────────────────────────────────────────────────┐
│ RowLens                      Local-only · no uploads       Theme   │
├────────────────────────────────────────────────────────────────────┤
│ file.csv  ·  84,320 rows  ·  12 columns  ·  UTF-8       [Remove]    │
├────────────────────────────────────────────────────────────────────┤
│ [ Search all columns... ] [Filter] [Columns] [Clean steps] [Export] │
├────────────────────────────────────────────────────────────────────┤
│ 1,243 of 84,320 rows match · 2 active filters · Reset               │
├───────────────┬────────────────────────────────────────────────────┤
│ CLEANING      │ DATA GRID                                           │
│ Pipeline      │ sticky header                                       │
│               │ virtualized rows                                    │
│ + Add step    │                                                     │
│ [Trim]        │                                                     │
│ [Remove empty]│                                                     │
│ [Deduplicate] │                                                     │
└───────────────┴────────────────────────────────────────────────────┘
```

- Header 简洁：左侧产品名，右侧主题切换与一个不抢眼的本地处理提示。
- 文件信息条显示当前文件、数据量、格式、warning；不要把这些信息做成大号 KPI 卡片。
- 工具条的视觉优先级：搜索 > Filter/Columns > Clean steps > Export（Export 可为主按钮，但只有文件导入完成后可用）。
- 数据网格是页面主体，占据可用高度；表头吸顶，左右滚动有明确反馈。
- 清洗管线可使用右侧 drawer 或网格上方 panel；在窄屏切换为 modal/sheet，不强行保留双栏。

### 初始空状态

主标题：`Explore a data file. Keep it on your device.`
辅助文案：`CSV, TSV and JSONL · No account · No upload`
主要按钮：`Choose a file`
次要操作：`Try sample data`
拖放区域采用细边框/轻背景，不使用巨大插画。示例数据必须是合成数据。

## 3. 导入体验

- 拖放时以明确但克制的 overlay 显示 `Drop to open`。
- 进度信息包含阶段（Reading / Parsing / Indexing）、记录数或已读字节、取消按钮。不能只显示无限旋转器。
- 如果解析错误是部分可恢复，显示 `Imported with warnings` 和数量；把警告集中在详情面板，不阻塞整个工作流。
- 文件过大时在解析前拒绝，并明确说明当前限制；不要在 UI 中出现“处理中”无限等待。
- 导入失败后保留可操作的重新选择入口；不得显示空表格假装导入成功。

## 4. 数据网格交互

- 表头文字左对齐；排序箭头只在 hover/focus/已排序时显示，但按钮本身始终可以被键盘访问。
- 选中/悬停颜色轻微，不用重色铺满整行。
- 对宽列使用省略号；双击复制/打开详情不是唯一操作路径，需提供明确的复制动作。
- 全局搜索右侧提供清除按钮；`Esc` 清除当前搜索并将焦点留在输入框。
- 列过滤条件应可单独清除；过滤条件总数可见。
- 行号/记录编号不是原文件物理行号。UI 使用 `Record 1` 等逻辑序号，必要时提供源记录编号。

## 5. 清洗面板

每条步骤呈现：步骤名称、简短说明、启用开关、编辑、删除。步骤编辑区说明：

- 参数作用范围（所有列/选定列/键列）；
- 预检结果（例如 `1,208 rows would be removed`）；
- Preview / Apply 的概念应一致。由于 pipeline 是配置驱动，Apply 只是保存步骤并重算，不修改原始源数据；需避免让用户误以为原文件已被改变。
- 提供 `Reset all steps`，并在清洗步骤较多时要求确认。
- 空状态不留白：“No cleaning steps yet” + `Add a step`。

## 6. 导出对话框

字段顺序：

1. 输出文件名；
2. 数据范围：`Filtered rows (1,243)` / `All rows (84,320)`；
3. 列范围：`Selected columns` / `All columns`；
4. 安全策略：默认 `Spreadsheet-safe CSV`，展开说明 `Raw CSV` 的风险；
5. 预估行数、列数、可能被转义单元格数量；
6. `Export CSV` 主操作，`Cancel` 次操作。

在导出阶段显示进度和取消；成功时简明提示文件已生成，不展示庆祝动画或浮夸徽章。

## 7. 响应式策略

- 桌面 1024px 以上为完整数据网格 + 清洗 panel。
- 700–1023px：工具栏换行，清洗 panel 可折叠。
- 360–699px：顶栏分区换行（不藏进菜单——每个工具都直接可见可达），表格允许水平滚动；搜索和导出必须容易找到。
- 关键对话框在窄屏内滚动，不超出动态可视区域；输入框获得焦点时不能因固定高度导致按钮不可达。

## 8. 可访问性

- 语义化按钮/表格；所有交互控件可通过 Tab/Shift+Tab、Enter/Space 操作。
- 输入有可见 label；icon-only 按钮必须有 aria-label 与可见 focus ring。
- 搜索结果计数和导入状态用合适的 `aria-live="polite"`，避免每个进度 tick 都读屏轰炸。
- 达到 WCAG AA 的常规文字对比度目标；颜色不是唯一信息编码。
- 尊重 `prefers-reduced-motion`；避免自动焦点抢夺与不必要的焦点陷阱。
- 键盘操作后焦点不丢失；对 modal 正确捕获并恢复焦点。

## 9. 动效原则

- 仅使用 120–180ms 的短过渡用于菜单、面板和 hover；默认不加弹簧动画。
- 导入/导出状态优先用进度条和文字；表格不要为每行添加进入动画。
- `prefers-reduced-motion: reduce` 时禁用非必要过渡。

## 10. 设计验收

- 首屏能在 5 秒内让新用户看懂“选文件—查看—清洗—导出”。
- 任意状态下，当前文件、导入状态和导出范围明确。
- 不能出现多组互相竞争的主按钮、重复提示、无意义大卡片或密集彩色徽章。
- 验证 360px、768px、1280px、1440px 宽度；验证长列名、长文件名、零行结果和导入警告。
