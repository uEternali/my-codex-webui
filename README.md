# Codex WebUI

<p align="center">
  <strong>由真实 Codex app-server 驱动、可在浏览器中使用的本地 WebUI。</strong>
</p>

<p align="center">
  <a href="./CONTRIBUTING.md">贡献指南</a> ·
  <a href="./SECURITY.md">安全政策</a> ·
  <a href="./LICENSE">MIT 许可证</a>
</p>

> [!IMPORTANT]
> 这是一个非官方社区项目，与 OpenAI 没有隶属或维护关系。Codex 及相关标识归各自权利人所有。

本项目直接连接 `codex app-server --stdio`，模型、历史会话、流式回复、工具调用和审批均由真实 Codex CLI 提供。关闭浏览器后任务仍可继续；停止或重启 WebUI 服务会中断它管理的后台任务。

![Codex WebUI 桌面截图](./docs/assets/overview.png)

## 主要功能

- 流式对话、模型和推理强度选择、上下文用量、Markdown 与 LaTeX 渲染。
- 工具活动、权限审批、错误和重试提示，以及 Unified / Split Diff、Undo / Reapply。
- 项目和会话管理：置顶、重命名、分支、归档、还原和删除。
- 图片与文件上传、粘贴、多附件预览，以及上传目录内的引用检查和清理。
- `/goal` 目标管理、`/compact` 上下文压缩，任务执行中可追加引导消息或按 Esc 停止。
- 本地 PTY 终端、浅色/深色主题、桌面和移动端布局。

普通分支是独立会话，删除原会话会保留其分支；代理创建的子任务按 Codex 原生逻辑连带删除。删除整个项目会删除该项目内的全部会话，但保留其他项目中的独立分支，工作目录中的文件不会删除。

## 环境要求

- [Bun](https://bun.sh/) 1.3+、Node.js 20+（PTY worker）、Git（Review）。
- 已安装并登录的 [Codex CLI](https://www.npmjs.com/package/@openai/codex)。协议功能取决于 CLI 版本，建议保持更新。
- 推荐 Linux / macOS；Windows 建议在 WSL2 中运行。

```bash
npm install -g @openai/codex
codex
```

## 快速开始

```bash
git clone https://github.com/uEternali/my-codex-webui.git
cd my-codex-webui
bun install
bun run start
```

打开 `http://127.0.0.1:8899`，选择项目工作目录即可开始。默认只监听本机。

### 局域网访问

```bash
HOST=0.0.0.0 bun run start
```

未配置认证变量时，首个局域网访问者需设置至少 12 位的密码；加盐后的凭据保存在 `$CODEX_HOME/codex-webui-auth.json`。请在可信网络中完成初始化。也可通过环境变量预设密码：

```bash
HOST=0.0.0.0 CODEX_WEBUI_PASSWORD='replace-with-a-long-random-password' bun run start
```

认证使用 `HttpOnly`、`SameSite=Strict` 会话 Cookie；localhost 请求可直接访问。

## 配置

参考 [.env.example](./.env.example)。Bun 从项目目录启动时会加载 `.env`，也可显式导出环境变量。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8899` | 监听地址和端口 |
| `CODEX_WEBUI_PASSWORD` | 未设置 | 浏览器登录密码 |
| `CODEX_WEBUI_AUTH_STORE` | `$CODEX_HOME/codex-webui-auth.json` | 本地密码凭据文件 |
| `CODEX_WEBUI_ACCESS_TOKEN` | 未设置 | Basic / Bearer 兼容密钥；未设密码时也可用于浏览器登录 |
| `CODEX_WEBUI_SESSION_COOKIE` | `codex_webui_session` | 同一主机运行多个实例时，使用不同名称隔离登录 |
| `CODEX_WEBUI_CWD` | 仓库目录 | 初始工作目录 |
| `CODEX_WEBUI_REVIEW_ROOT` | 与 `CODEX_WEBUI_CWD` 相同 | 允许 Undo / Reapply 的 Git 根目录 |
| `CODEX_HOME` | `~/.codex` | Codex 配置、认证和会话目录 |
| `CODEX_AUTH_PATH` | `$CODEX_HOME/auth.json` | 可选认证文件路径 |
| `CODEX_WEBUI_UPLOAD_DIR` | `$CODEX_HOME/codex-webui-uploads` | 图片和文件上传目录；可独立设置为缓存目录 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 自动检测 | 浏览器测试使用的 Chrome / Edge 路径 |

开发和生产应分别配置端口、`CODEX_HOME` 和 Cookie 名称。上传目录可以共用，引用索引按 `CODEX_HOME` 隔离；迁移时保留附件和引用索引，避免历史附件链接失效。

上传文件采用 `UUID + 原文件名`。移除待发送附件或永久删除会话时，服务会检查其他会话、分支和已登记环境的引用，仅清理上传目录内不再使用的文件；归档不删除附件。无法确认引用时保留文件，不按固定期限自动清理历史附件。

## 开发与测试

源码主要位于 `server.ts`、根目录的服务模块和 `public/`；`tests/` 包含单元和浏览器测试。

```bash
bun run dev        # 监听源码，前端重建、后端重启
bun run build      # 生成 public/app.bundle.js 和 dist/server.js
bun run test:unit  # 单元测试
bun run check     # 构建检查
```

构建后可用 `bun dist/server.js` 启动。`node_modules/`、浏览器 Bundle 和 `dist/` 为安装或构建产物，不手工修改。

浏览器测试需要兼容的 Chromium 浏览器，必要时先运行 `bunx playwright install chromium`。`bun run test:browser` 包含独立模拟服务测试，也有连接运行中服务的测试；通过 `CODEX_WEBUI_TEST_URL` 指向专用测试实例。`test:integration` 和 `test:e2e` 中部分测试需要已登录的真实 Codex，避免对生产实例执行这些测试。

## 安全与限制

- 本工具可执行命令、修改文件和操作终端，应按 Shell 工具管理访问权限；远程访问建议使用可信内网、VPN 或 SSH 隧道。
- HTTP / WebSocket 有认证和 Origin 校验，文件访问、目录浏览、Review 和附件清理有路径边界检查；这些边界不能替代 Codex 自身的权限审批。
- 不要公开密码、密钥、`auth.json`、会话记录或运行日志。漏洞报告见 [SECURITY.md](./SECURITY.md)。
- app-server 协议持续演进；部分原生桌面能力在浏览器中不可用，Review 暂不支持逐 Hunk 应用。

## 版本记录

### 1110（2026-11-10）

- **长会话性能**：首屏按需展示最近 80 条记录，支持分批展开；折叠输出按需渲染，历史更新保留展开状态，减少桌面和移动端的渲染开销。
- **同步效率**：主会话和子代理按版本同步，内容不变时跳过完整历史传输和重复读取；限制缓存数量，减少后台轮询。
- **弱网加载**：静态资源支持压缩与缓存校验，会话历史通过 HTTP gzip 传输，实时事件继续使用 WebSocket。单个长会话样本由约 6.68 MB 压缩至 1.81 MB，传输量减少约 73%。
- **连接恢复**：账户和权限异步加载，请求超时后支持重试；网络慢时提示并继续加载，改善连接恢复及切换会话时的状态处理。
- **主题与终端**：修复终端主机名显示；浅色界面背景略微加灰，终端提高 ANSI 配色饱和度，文字对比度不低于 7:1，保留现有深色配色。

### 1109（2026-11-09）

- **界面与主题**：右侧栏支持拖动宽度，统一侧栏和底部标签样式；新增炭灰色深色模式，保存主题偏好并跨窗口同步，终端与代码高亮随主题切换；优化移动端布局和输入时的缩放。
- **会话与输入**：被占用会话显示只读状态，空输入框支持上下键切换历史输入；项目会话按最近消息排序，每次显示 5 个；统一删除会话、项目和临时聊天的确认弹窗。
- **文件管理**：新增项目文件树和多标签文件预览，支持按需加载、自动刷新、文件类型图标及语法高亮；浏览文件不改变会话工作目录。
- **终端与审阅**：支持多个 PTY 终端标签，新终端默认进入当前项目目录；完善审阅差异浏览，复用文件预览的布局和代码高亮。
- **子代理与状态**：显示子代理活动、聊天关系和审批，支持在主对话及侧栏处理子代理审批；会话状态面板展示 Thread ID、上下文用量等信息。
- **侧边聊天**：通过 `/side` 或右侧面板创建继承当前上下文的临时聊天，独立运行；关闭前确认，随后清理临时会话。

### 1108（2026-11-08）

- **界面与交互**：优化导航、加载状态、模型和输入框布局，统一按钮与菜单样式；左上角显示静态的 Codex Web UI 标题。
- **对话体验**：优化消息气泡、即时反馈和引导消息顺序；显示处理状态、错误及重试、完成时间，支持复制原文和从指定回复创建分支。
- **会话管理**：增加项目新建与批量操作、会话重命名和置顶、归档还原；刷新保持当前窗口的会话，直接打开首页进入新对话。
- **附件**：完善输入法、多文件粘贴和上传取消；统一图片缩略图与文件卡片，永久删除会话时安全清理不再引用的附件。
- **命令支持**：完善 `/goal` 的创建、修改、暂停、继续、删除，以及 `/compact` 的执行状态和异常反馈。
- **稳定性**：修复历史增量读取的中文字符边界、置顶和分支分页丢行、重复提交与切换会话竞态；恢复长会话分批渲染和 SSE 重连状态同步，启用 DOMPurify 清理 Markdown HTML。

后续版本在此追加记录。

## 许可证与来源

源码采用 [MIT License](./LICENSE)。品牌资源及第三方组件适用各自条款，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

本项目基于 [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) 继续开发，感谢原作者及贡献者。当前 Fork：[uEternali/my-codex-webui](https://github.com/uEternali/my-codex-webui)。
