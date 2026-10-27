# RowLens 发布验收清单

逐项勾选并附证据。不能仅以"看起来完成"作为通过。
逐项证据的完整记录在 [docs/acceptance-walkthrough.md](acceptance-walkthrough.md)（最后核验 2026-10-27）。

## 安装与工程

- [x] 在干净工作区按 README 指令安装，锁文件安装成功。
  证据：2026-10-27 `rm -rf node_modules && npm ci` 成功，`found 0 vulnerabilities`，装后
  typecheck / 448 unit tests / build 全部通过。
- [x] `typecheck`、unit tests、production build 全部通过。
  证据：每批验证记录；最近一次 33 文件 / 448 测试、build + 网络审计 OK。
- [x] CI 使用锁文件安装，不发生未声明依赖。
  证据：仓库建立后 CI 首跑全绿（run 40468822644，2026-10-27）：`npm ci` 安装、
  node 22/24 双版本 verify（typecheck/unit/build/format）与 e2e（含生产构建预览）
  三个 job 全部通过。
- [x] 无未使用的大型依赖；无远程字体、CDN 脚本、遥测或文件上传接口。
  证据：依赖仅 react / react-dom / papaparse / @tanstack/react-virtual，全部在用；
  生产构建网络审计（scripts/audit-network.mjs）每批通过。

## 导入

- [x] CSV/TSV 能正确处理引用逗号、引号、跨行字段、BOM、CRLF/LF。
- [x] JSONL 能处理 UTF-8 chunk 边界、CRLF、最后一行无换行、无效行继续解析。
- [x] 重复/空列名不会覆盖数据；前导零与日期字符串保留。
- [x] 导入有进度、可取消；快速换文件不会混淆结果。
- [x] 超出大小/行长度/存储限额时安全失败并显示说明。
- [x] 部分失败不被标记为完整成功。

证据：parser contract tests、import coordinator 测试与 E2E（走查记录"导入"节）。

## 查询与 UI

- [x] 搜索、列过滤、稳定排序、清除条件、隐藏列工作正确。
  含 ADR-034 定向搜索与 ADR-035 数值排序。
- [x] 虚拟化验证：DOM 中渲染行数与 viewport 相关而非总记录数。
- [x] 零结果、警告、错误和空状态均有可操作下一步。
- [x] 360px、768px、1280px、1440px viewport 布局通过。
- [x] 仅用键盘完成核心路径；焦点环可见；对比度检查通过。

证据：engine/client/search/numeric 单测、keyboard/viewport/a11y E2E（走查记录对应节）。

## 清洗与导出

- [x] Trim 不改内部空格。
- [x] Empty-row 删除行为符合选定列范围。
- [x] Dedup 保留第一条，键列与全行模式正确，稳定排序成立。
- [x] pipeline 启停/重置正确，原始 IndexedDB rows 未改变。
- [x] Filtered vs All 导出范围有明确区分。
- [x] CSV quoting 和 CRLF 正确；独立解析回读结果与预期一致。
- [x] Spreadsheet-safe 与 Raw 模式有不同 UI 提示和测试。
- [x] 大导出、取消、保存失败、Object URL 生命周期有测试。

证据：transform/serializer/run 单测、export E2E（含所选矩形下载逐行断言）。

## 隐私与安全

- [x] 解析/清洗后 Network 面板未发现文件内容外传。
- [x] XSS 样例只显示为文本。
- [x] Formula injection fixtures 得到预期安全/原始导出行为。
- [x] 移除 dataset、退出、过期 cleanup 与配额错误路径验证过。
- [x] 文件名和错误文本不会被渲染成 HTML；敏感行不会写入 console。

证据：安全单测组、网络审计、走查记录"隐私与安全"节。

## 发布质量

- [x] README 不包含未经实测的性能承诺。
  证据：性能数字均引 docs/performance-results.md 并注明方法与 PERF 门控。
- [x] README 明示支持格式、限制、隐私边界和 CSV 安全导出策略。
- [x] 合成示例数据与截图不存在真实个人信息。
  证据：样例为种子 LCG 生成；截图内容全部为合成样例（2026-10-27 重新生成）。
- [x] LICENSE、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG 齐全。
- [x] 已知限制公开记录；无未解决 P0/P1。
- [ ] 远程发布、仓库创建、打 tag 等动作已获得维护者授权。
  状态：**待授权**。发布动作（建仓库、推送、打 tag、Release）在授权前不执行。
