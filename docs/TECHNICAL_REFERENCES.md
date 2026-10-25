# 技术依据与资料来源

> 本清单以 2026-10-25 为研究快照。依赖版本应在实现时重新确认稳定版本、维护状态和许可证；不要将文档中的架构决策误读为固定版本承诺。

## RowLens

### 技术资料

- [Vite Guide](https://vite.dev/guide/) — 快速开发服务器和静态构建；当前文档列出的 Node.js 兼容要求需在安装时再次确认。
- [Vite TypeScript features](https://vite.dev/guide/features) — Vite 默认转译 TypeScript，但不负责完整类型检查，因此 CI 必须另跑 `tsc --noEmit`。
- [Papa Parse docs](https://www.papaparse.com/docs) — 支持本地文件、CSV/TSV 分隔符、chunk/step 流式解析、错误信息和可取消解析。
- [Papa Parse FAQ](https://www.papaparse.com/faq) — 大文件应使用流式处理，而非一次性把所有原始文本读入内存；worker 可减少 UI 阻塞。
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) — Headless 虚拟化，保留项目对布局和样式的控制权。
- [MDN Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) — 将 CPU 密集工作移出 UI 主线程；明确消息传递和 worker 安全边界。
- [MDN File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications) — 本地文件和 Object URL 生命周期管理；创建的 URL 应在不再需要时 revoke。
- [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — File System Access API 仅在受支持、可信上下文中可用；必须保留兼容回退。
- [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) 与 [OWASP WSTG CSV Injection](https://owasp.github.io/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Injection/21-CSV_Injection) — CSV 被电子表格打开时，公式字符可能导致公式注入风险。

### 已发现的相关产品/竞品

- [mynl/CSV_Viewer](https://github.com/mynl/CSV_Viewer) — 浏览器内 CSV/TSV 查看、排序、过滤和大文件处理；说明单纯“能本地看 CSV”并不构成差异化。
- [dataloupe](https://github.com/aurelio-nakamura/dataloupe) — 将数据文件生成离线、可交互的 HTML 浏览器，并提供查询能力；RowLens 不应以“本地数据预览”作为唯一卖点。
- [LeanRows](https://github.com/abooodbah/leanrows) — Windows 原生只读大文件查看器，覆盖 CSV/TSV/JSONL/NDJSON 等；表明大文件查看领域已有高性能原生产品。
- [CEESVEE](https://github.com/soldforaloss/ceesvee) — 跨平台 CSV 编辑器，强调大文件和数据往返保真；RowLens 不应盲目争夺原生桌面编辑器同一卖点。

### RowLens 产品决策

差异化应聚焦：**可审查、可撤销的清洗流程**，每项转换都可单独预览影响行数，并允许导出“筛选结果”或“完整数据的清洗版本”。本地处理和虚拟化是基础条件，不是独立竞争优势。首版不承诺 GB 级打开；性能数字仅能由自己的测试得到。

## RepoRead

- [Python argparse](https://docs.python.org/3/library/argparse.html) — 标准库命令行参数解析。
- [Python pathlib](https://docs.python.org/3/library/pathlib.html) — 路径处理。
- [GitHub Community Health Files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file) — 常见社区健康文件约定。
- 相关同名/近名工具可能存在，例如 [OpenSource-Communities/RepoReady](https://github.com/OpenSource-Communities/RepoReady) 与 [kanuwrld/repoready](https://github.com/kanuwrld/repoready)。RepoRead 名称仅为工作名，发布前必须重新检查 GitHub、PyPI、商标和软件包名冲突。

## CleanSlate

- [exifr](https://github.com/MikeKovarik/exifr) — JavaScript 图片元数据读取库；应作为打包时依赖，而非 CDN 运行时脚本。
- [MDN Blob](https://developer.mozilla.org/en-US/docs/Web/API/Blob) — 浏览器二进制数据处理基础。
- [MDN File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications) — 文件选择与下载。
- [ascend-exif-editor](https://github.com/alestre/ascend-exif-editor) 与 [exif-cleaner](https://github.com/OG34/exif-cleaner) — 已有浏览器本地元数据工具；CleanSlate 必须明确格式支持、无损边界和处理前后可验证差异。

## 重新核验规则

如果实现时所用 API 或依赖已变更：

1. 优先查看官方文档和仓库发布说明；
2. 核对浏览器支持矩阵、许可证、最近维护情况和已知安全问题；
3. 更新对应 ADR / 决策记录；
4. 更新 package lock 或 Python 配置并运行完整测试；
5. README 不得夸大未实际验证的兼容性。
