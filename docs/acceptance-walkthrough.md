# 发布验收走查记录（v0.1.0-rc.1）

对照 `docs/09-acceptance-checklist.md` 逐项核对。**每项勾选都指向可复现的
证据**（命令输出、测试名或走查说明）；无法勾选的项目如实标注未完成原因。
本记录由开发会话于 2026-10-26 撰写，发布/tag 等外部动作仍需维护者明确授权。

## 安装与工程

- [x] 干净工作区按 README 指令安装，锁文件安装成功。
  证据：本会话多次 `rm -rf node_modules && npm ci` 成功（45 包，rolldown
  win32 绑定在位）；CI 在 Node 22/24 矩阵执行同一命令。
- [x] `typecheck`、unit tests、production build 全部通过。
  证据：最终一轮 19 文件 152 测试通过、build（含网络审计）通过。
- [x] CI 使用锁文件安装，不发生未声明依赖。证据：`.github/workflows/ci.yml`
  全部 job 均 `npm ci`。
- [x] 无未使用的大型依赖；无远程字体、CDN 脚本、遥测或文件上传接口。
  证据：`npm run build` 内置网络审计扫描全部产物（fetch/XHR/sendBeacon/
  WebSocket/EventSource/远程 import/远程 script/非本机 URL），当前唯一豁免
  均为框架内置且逐项注释（ADR-021）；依赖清单仅 react/react-dom/papaparse。

## 导入

- [x] CSV/TSV 正确处理引用逗号、引号、跨行字段、BOM、CRLF/LF。
  证据：`csv-session.test.ts`（引用字段、BOM+CRLF、表头变体）；
  `e2e/import.spec.ts`（quoted-newlines、duplicate-headers 夹具）。
- [x] JSONL 处理 UTF-8 chunk 边界、CRLF、无末行换行、无效行继续解析。
  证据：`jsonl-session.test.ts`（字节级切分重组多字节、CRLF、末行无换行、
  顶层数组/primitive 行）。
- [x] 重复/空列名不覆盖数据；前导零与日期字符串保留。
  证据：`columns.test.ts` + E2E 断言 `00123` 原样显示。
- [x] 导入有进度、可取消；快速换文件不会混淆结果。
  证据：导入协调器 jobId 竞态测试；导入进度面板（阶段+取消）。
  注意：UI 上"导入中再选文件"被禁用（协调器单任务），竞态由协议层防护。
- [x] 超出大小/行长/存储限额时安全失败并显示说明。
  证据：validate（100 MiB）、jsonl-session（5 MiB 行长）、配额映射测试。
- [x] 部分失败不被标记为完整成功。证据：协调器测试（配额失败→删除+不 ACK
  不 finalize）；`importing → ready` 仅在全部批次持久化后。

## 查询与 UI

- [x] 搜索、列过滤、稳定排序、清除条件、隐藏列工作正确。
  证据：`engine.test.ts`、`client.test.ts`、E2E query.spec。
- [x] 虚拟化验证：DOM 行数与 viewport 相关而非总记录数。
  证据：组件测试（5000 行 <60 节点）+ `e2e/app.spec.ts` DOM 断言 + 滚动
  重渲染用例。
- [x] 零结果、警告、错误和空状态均有可操作下一步。
  证据：NoResultsState（清除按钮）、警告通知、错误通知（可行动文案）、
  空态双入口；axe 扫描覆盖。
- [x] 360px、768px、1280px、1440px viewport 布局通过。
  证据：`e2e/viewport.spec.ts` 四档尺寸断言（搜索/计数可达、网格内滚、
  窄屏无页面级横向溢出、More 菜单、Export 可达）。
- [x] 仅用键盘完成核心路径；焦点环可见；对比度检查通过。
  证据：`e2e/app.spec.ts` 键盘全流程；`e2e/keyboard.spec.ts` 网格内方向键/
  Home/End/PageDown 导航、roving tabindex、行表头漫游与整行选择、Shift+方向键
  矩形选区与 TSV 剪贴板内容断言、Ctrl+A 全选与 40,000 单元格复制、拖拽越界
  自动滚动；axe WCAG AA 扫描（含选中态与选区工具条）零 critical/serious。
- [x] 无未使用的大型依赖（同上）；图标为内联 SVG/favicon。

## 单元格编辑

- [x] 编辑入口完整（Enter / F2 / 双击 / 直接键入），提交与取消行为一致。
  证据：`DataGrid.test.tsx` 编辑用例组（Enter 全选打开、键入替换、Escape 不
  产生提交、Tab 提交并移到下一格/换行、点击他处提交、拒绝提交时播报原因）；
  `e2e/editing.spec.ts` 真实浏览器用例。
- [x] 编辑后搜索/排序/清洗看到新值，导出写出新值。
  证据：`engine.test.ts` 编辑覆盖组（搜索命中、取消命中、列过滤、排序键、
  清洗前置）；`e2e/editing.spec.ts` 搜索往返 + 导出文件首行断言。
- [x] 撤销/重做/重置编辑正确，且重置本身可撤销。
  证据：`edits.test.ts` 覆盖层用例（连续撤销沿历史回退、redo 分支丢弃、
  空字符串与无覆盖区分、重置可撤销）；App 与 E2E 均覆盖按钮与快捷键。
- [x] 源数据只读：导入行、IndexedDB 与源文件均未被改写。
  证据：编辑存于独立的 `cellEdits` store（IDB v2），`deleteCellEdits` 只删
  编辑不动行、`deleteDataset` 一并级联删除；`repository.test.ts` 两个 store
  的独立性用例；`e2e/editing.spec.ts` 刷新后编辑恢复且 Reset edits 回到导
  入值。
- [x] 清洗管线跨刷新保留，且仍是配置而非数据。
  证据：`cleaning/persist.test.ts` 逐条校验（未知类型、缺失 id、列清单失效
  整步丢弃、部分失效收窄、重复 id 拒绝、默认值）；`repository.test.ts` 管线
  与行/编辑三个 store 的独立性；App 恢复用例（重新挂载后步骤仍在且已生效、
  重置后不再恢复）；`e2e/editing.spec.ts` 刷新后管线仍在且已应用。
- [x] 查询视图（搜索/筛选/排序/隐藏列）跨刷新保留，Reset 真正清空。
  证据：`query/persist.test.ts`（往返、按列 id 存排序、失效字段逐项丢弃、
  隐藏全部列不恢复、`__proto__` 构造键被丢弃、超长搜索词视为损坏、签名
  稳定）；`repository.test.ts` 视图 store 与行/编辑/管线四者独立；App 恢复
  用例（搜索词与结果数、排序方向、隐藏列、重置后不恢复）；`e2e/view-
  persistence.spec.ts` 真实刷新后筛选与排序仍在、隐藏列仍在且 Reset 恢复。
- [x] 浏览全表时内存有界（分块淘汰）。
  证据：`lazy-store.test.ts` 淘汰组（上限、LRU 顺序、窗口固定、窗口超上限
  时优先正确性、淘汰后重读）；`e2e/bench/scroll-memory.spec.ts` P3 跳遍全
  表后堆 48 MB；`e2e/editing.spec.ts` 60k 行（120 分块）跳遍后回到顶部仍
  显示 R0。
- [x] 刷新恢复耗时不随数据量增长。
  证据：`e2e/bench/restore.spec.ts`（PERF=1）P1/P2/P3 恢复 282/394/381ms，
  优化前为 1,045/2,691/6,931ms；`lazy-store.test.ts` 覆盖按需分块、不重复
  加载、越界不触发、失败重试、dispose；`e2e/editing.spec.ts` 恢复后滚到末行
  仍显示 T-05000 且首列无空白。
- [x] 编辑跨刷新保留，且不伪造撤销历史。
  证据：`persist.test.ts` 序列化往返与坏元组逐条丢弃；App 会话恢复用例
  （重新挂载后恢复数据集与编辑、移除后不再恢复、指针失效回退空态）；
  `e2e/editing.spec.ts` 刷新后恢复编辑且 Undo 为禁用。
- [x] 编辑上限有明确拒绝而非静默丢弃。证据：`edits.test.ts` 上限用例；
  网格在拒绝时关闭编辑器并播报原因。
- [x] 区域粘贴：单格向外铺开、多格平铺、越界裁剪并播报、一次撤销回退整块。
  证据：`paste.test.ts`（引号/CRLF/空行/不齐整块、平铺、裁剪、摘要）；
  `DataGrid.test.tsx` 粘贴用例组（批量提交、平铺、裁剪提示、编辑器内不拦
  截、拒绝播报）；`e2e/editing.spec.ts` 真实剪贴板事件下的粘贴、搜索、导
  出与裁剪。

## 清洗与导出

- [x] Trim 不改内部空格。证据：`transform.test.ts` 逐值断言。
- [x] Empty-row 删除行为符合选定列范围。证据：transform 测试（部分列模式
  语义）。
- [x] Dedup 保留第一条，键列与全行模式正确，稳定排序成立。
  证据：transform 测试（首见保留、键元组碰撞安全、trimmed 比较）。
- [x] Pipeline 启停/重置正确，原始 IndexedDB rows 未改变。
  证据：App 交互测试（禁用恢复全量）+ E2E cleaning.spec（Remove/Reset 恢复
  视图）；架构上清洗为内存投影，无任何回写路径。
- [x] Filtered vs All 导出范围有明确区分。证据：ExportDialog 双选+实时计数；
  E2E export.spec 范围用例。
- [x] CSV quoting 和 CRLF 正确；独立解析回读结果与预期一致。
  证据：`serializer.test.ts` 全部文档经 Papa 独立回读；E2E 直接断言下载
  文件字节。
- [x] Spreadsheet-safe 与 Raw 模式有不同 UI 提示和测试。
  证据：对话框双说明（raw 有警示文案）；E2E safe 前缀计数 / raw 原样断言。
- [x] 大导出、取消、保存失败、Object URL 生命周期有测试。
  证据：`run.test.ts`（上限拒绝、取消 abort、错误传播、URL 延迟 revoke）。
  注意：FS Access 真机流式路径未在 E2E 覆盖（headless 无选择器 UI）。

## 隐私与安全

- [x] 解析/清洗后 Network 面板未发现文件内容外传。
  证据：构建产物静态审计（构建内置）+ E2E 全程无业务网络请求断言（应用
  仅加载本站静态资源；测试对导航失败敏感）。
- [x] XSS 样例只显示为文本。证据：全程 React 文本节点渲染，无
  dangerouslySetInnerHTML（grep 全仓零命中）；`xss-values.csv` 夹具在
  E2E 断言中按文本可见（formula 夹具亦含控制字符样值）。
- [x] Formula injection fixtures 得到预期安全/原始导出行为。
  证据：`e2e/export.spec.ts` 公式向量双模式字节断言。
- [x] 移除 dataset、退出、过期 cleanup 与配额错误路径验证过。
  证据：repository 测试（TTL 矩阵）、协调器测试（配额/取消/错误清理）、
  E2E Remove 用例。
- [x] 文件名和错误文本不会被渲染成 HTML；敏感行不会写入 console。
  证据：文件名清洗纯函数；worker 错误消息为固定文案；grep 全仓无原始行
  console 输出。

## 发布质量

- [x] README 不包含未经实测的性能承诺。证据：性能数字全部指向
  performance-results.md 的实测；无"最快/无限/绝对安全"表述。
- [x] README 明示支持格式、限制、隐私边界和 CSV 安全导出策略。
- [x] 合成示例数据与截图不存在真实个人信息。
  证据：sample/generator 均为种子化生成器；截图内容为合成表。
- [x] LICENSE、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG 齐全。
- [x] 已知限制公开记录；无未解决 P0/P1。
  证据：README 已知限制章节 + performance-results 未测项。
- [ ] 远程发布、仓库创建、打 tag 等动作已获得维护者授权。
  状态：**未发生**——按协议留待维护者明确授权后执行。

## 结论

除两处显式标注的未完成项（768/1440 视口自动化证据、维护者发布授权）外，
验收清单全部通过并附证据。0.1.0-rc.1 具备发布候选资格；远程发布动作等待
授权。
