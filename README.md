# dsh-skill-panel

`@lovenndme/dsh-skill-panel` — DSH 技能管理面板：在 **设置 → 技能** 里用一个页面管理「全局」和「本项目」两层技能。

- 列表：名称、描述、来源（全局 / 本项目）、路径、模型可调用、`/命令` 可调用、同名覆盖情况
- 安装位置：技能装在哪里，只在**新建 / 导入时选择一次**——「全局」（`~/.dsh/skills`，所有项目可用）或「本项目」（顶部所选项目的 `.dsh/skills`）。列表里不提供「全局 ⇄ 本项目」切换：技能本身占用的 token 很少，又是渐进式披露，不需要按项目来回搬。
  - 列表按文件所在位置分成「全局技能」「本项目技能」两组；本项目里的同名技能会盖过全局那份，行上标「覆盖 ~/.dsh」。
  - 旧版本留下的「本项目禁用占位」行，删除即恢复全局那份。
- 启用开关：详情里一个「启用」开关，同时改写 `disable-model-invocation` 与 `user-invocable` 两行（开 = 模型与 `/命令` 都可调用，关 = 都不可调用）；文件里只开了其中一项时显示「部分」，列表标「部分启用」，点一下统一成全开。
- 查看 / 编辑：详情默认「预览」，frontmatter 显示为字段卡片，正文用 DSH 聊天界面同一个 Markdown 渲染器（Web 外壳共享模块 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`）。这不是文档化的插件 API，拿不到或渲染出错时退回纯文本。切到「编辑」直接读写 SKILL.md 全文，未保存的修改切回预览也能看到。
- 新建 / 删除：可指定建在全局还是本项目；删除是移到回收目录（`~/.dsh/skill-panel-trash/`），不真删
- 导入：本地文件夹路径（单个技能目录，或包含多个技能子目录的上层目录），或 `.zip` 压缩包
- 搜索：名称 / 描述 / 路径

界面文案中文；插件元数据同时提供 `zh` / `en` 两份。

## 技能契约

与 `@deepseek-ai/dsh-skill-filesystem` 完全同口径，不引入任何私有格式：

| 作用域 | 根目录 | rank |
|---|---|---|
| 本项目 | `<项目根>/.dsh/skills` | 100 |
| 本项目 | `<项目根>/.agents/skills` | 200 |
| 全局 | `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | 400 |
| 全局 | `~/.agents/skills` | 500 |

- 技能 = `<root>/<name>/SKILL.md` 目录形式，或 `<root>/<name>.md` 平铺文件；只扫一层。
- 项目根 = 从当前工作区向上找到的最近一个含 `.git` 的目录（与宿主一致，找不到退回工作区本身）。
- 「关掉技能」只有一种官方机制：frontmatter 的 `disable-model-invocation: true`（模型不可见）与 `user-invocable: false`（`/name` 不可调用）。面板只改这两行，不动 body、不动别的键、保留 BOM 与 CRLF。

### 与 DSH 实际加载结果保持一致

面板自己的 frontmatter 解析是简化版。为了避免「面板显示正常、DSH 却忽略」，有两道关：

1. **本地校验对齐 DSH（`inspectSkillDoc`）**：扫描、导入、保存都走同一套规则。以下写法 DSH（dsh-skill-filesystem 0.2.1-rc.5）会忽略整个技能，面板会直接拒绝并给出原因：
   - 缺少 `name`（不再拿目录名顶替）
   - 出现旧键 `userInvocable` / `modelInvocable` / `disableModelInvocation`
   - `name` / `description` 未加引号，会被 YAML 读成数字、布尔或 null（规则已用 DSH 自带的 yaml 2.9.1 核对）
   - 顶层键重复
2. **向 DSH 注册表核对**：宿主通过 `ctx.get('skills')` 拿到 DSH 的技能注册表。0.2.x 里本地技能 provider 挂在每个 agent preset 的作用域里，所以核对是逐个 preset `agentPresets.acquireScope(id)` → `skills.snapshot({ cwd, scope })`，用完释放租约；任一 preset 能看到这一份就算会被加载。`/list` 给每一行标注 `dsh.state`：`loaded`（有 preset 生效的正是这一份）、`other`（DSH 有同名技能，但没有任何 preset 采用这一份）、`missing`（没有任何 preset 加载这个名字）。写操作返回前会等注册表追上磁盘（最多 1.5 秒轮询），所以紧接着的 `/list` 不会读到写之前的旧视图。拿不到注册表时，面板照常工作，只是不做标注（`dshChecked: false`）。

### 作用域切换是怎么落盘的（宿主接口仍在，界面已不再提供切换）

- **全局 → 本项目**：先给全局那份写 `disable-model-invocation: true` / `user-invocable: false`（停用），再把整份技能复制到 `<项目>/.dsh/skills/<name>/`（目录形式，副本 frontmatter 显式打开两个开关）。项目层 rank（100）压过全局层（400），所以副本生效、全局那份不再注入。
- **本项目 → 全局**：把项目副本移到 `~/.dsh/skill-panel-trash/`，再把全局那份的两个开关打开。若全局目录里已有同名文件，先把它移进回收目录再写入，避免静默覆盖。
- 旧版本留下的「本项目禁用占位」（body 里带 `dsh-skill-panel: project-disable` 标记）仍被识别：选中「全局」会移除占位并恢复全局那份；选中「本项目」会把它换成真正的启用副本。

## 数据通道

宿主半区只在 `/api/dsh-skill-panel/` 下注册自己的路由，不注册任何模型工具，也不改任何全局配置：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/list?project=` | 两层技能清单 + 工作区列表 + 诊断 |
| GET | `/doc?project=&name=&source=` | 读 SKILL.md 全文（≤1MB） |
| POST | `/save` | 写回全文（校验 frontmatter 且 `name` 不允许改） |
| POST | `/flags` | 精确改 `disable-model-invocation` / `user-invocable` |
| POST | `/scope` | 作用域双向切换（全局 ⇄ 本项目，含副本复制与全局停用/恢复）；界面只在删除旧占位行时用它恢复全局 |
| POST | `/create` | 新建技能（全局或本项目） |
| POST | `/delete` | 移到回收目录 |
| POST | `/import-folder` | 从本地目录导入 |
| POST | `/import-zip` | 从 zip 导入（自实现的最小 zip 读取，store/deflate；拒绝 zip64 与路径穿越） |

`project` 缺省时取最近一个会话的工作目录，其次取工作区注册表的第一个。

## 安全边界

- 路由走 DSH 官方的 Connection 信任围栏（`ctx.connection.requestRejection`）：Host/Origin 检查 + 浏览器登录凭据，未登录的请求一律 401；composition 里没有 Connection 服务时才退回本机 loopback 判断。
- 写操作先按 root 重新定位技能，不看客户端传的路径；删除前再校验目标确实位于某个技能根目录之内。
- 导入：zip ≤32MB、解压后 ≤64MB、条目 ≤2000，路径穿越直接拒绝；目标已存在同名技能时不覆盖。
- 占位删除只认本插件写的标记。

## 安装

```powershell
# npm（推荐）
dsh plugin --profile web add @lovenndme/dsh-skill-panel
```

国内无代理时，「插件 → 添加插件」里把安装源切成「中国大陆镜像源」（`registry.npmmirror.com`），再粘贴包名；npm 包会自动同步，通常几分钟内拿到最新版。只有安装这一步需要联网。

本仓库开发模式（本机 `desktop` profile 里装的是本目录的 link，entry id：`include:dsh-skill-panel`）：

```powershell
# 装 / 重装
plugin_manager install_bundle --target C:\Users\lenovo\Documents\DSH-Workspace\dsh-skill-panel
# 改完代码：换模块代次（客户端半区要刷新页面）
plugin_manager set_plugin --target include:dsh-skill-panel --enabled false
plugin_manager set_plugin --target include:dsh-skill-panel --enabled true
```

卸载：`plugin_manager remove_bundle --target @lovenndme/dsh-skill-panel`。

## 测试

```powershell
npm test                 # 全部 113 条
npm run test:unit        # 纯函数：frontmatter / 扫描 / 写入 / 导入 / zip
npm run test:host        # 路由层：鉴权、方法、体积上限、并发、响应契约
npm run test:client      # 浏览器半区：组件渲染与「点了按钮发什么请求」
```

| 文件 | 覆盖 |
|---|---|
| `test/host.test.mjs` | frontmatter 解析 / 布尔语法 / 开关改写 / 两层去重 / 占位 / 导入 / 自造 zip |
| `test/lib-deep.test.mjs` | 边界与对抗：块标量里的 `---`、CRLF/BOM 保真、目录链接（junction）、坏链接诊断、同层同名、并发写串行化、zip 炸弹与路径穿越、200 条技能的性能护栏 |
| `test/apply.test.mjs` | 假 ctx 真跑 `apply()`：路由注册、落盘、跨站拒绝、按 preset 作用域核对 DSH 加载状态、作用域双向切换 |
| `test/routes.test.mjs` | Connection 鉴权（401/403）、405、坏 JSON、2MB 体积上限、路径越界、并发交错、zip 经 HTTP 落盘、格式保真回归（块标量/CRLF/emoji 不被改写） |
| `test/client.test.mjs` | 用极简 React 替身真跑 `client.js`：插槽注册契约、首屏骨架、搜索过滤、删除二次确认、详情读文件与开关请求、错误展示 |
| `test/integration.test.mjs` | 端到端：真 `node:http` 服务器 + 真宿主路由 + 真磁盘 + 真客户端组件（切开关改文件、创建技能、删除进回收目录） |

`test/helpers/mini-react.mjs` 是那个极简 React 替身（createElement + 5 个 hook + forwardRef + 错误边界）。
它只实现 `client.js` 用到的子集：hook 状态按组件在树里的路径保存，条件渲染会让状态错位——面板目前没有这种写法。

## 已知限制

- 旧版本留下的「本项目禁用」占位：如果项目里本来就有同名真实技能，恢复会被拒绝而不是覆盖。
- 只扫面板认得的四个默认根；宿主 `customSkillDirs` 里挂的技能不在列表里（宁可漏报也不误报）。
- 预设层（preset 自带、经作用域挂载的技能）不显示；面板只读写磁盘上的项目层与全局层。
- 删除是移到 `~/.dsh/skill-panel-trash/`，不自动清理。
- zip 只认根级 `SKILL.md` 或一层目录 `<dir>/SKILL.md`；更深的嵌套（如 `repo-main/skills/foo/SKILL.md`）会被拒绝并提示「压缩包里没有技能」。
- DSH 加载状态只核对每个名字的生效那一份；被覆盖的副本能否被 DSH 解析不做标注。
- 面板界面文案是中文硬编码（未经过 Client locale 服务）；插件元数据有 zh/en 两份。
