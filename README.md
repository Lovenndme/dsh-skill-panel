# dsh-skill-panel

DSH 技能管理面板：在 **设置 → 技能** 里用一个页面管理「全局」和「本项目」两层技能。

- 列表：名称、描述、来源（全局 / 本项目）、路径、模型可调用、`/命令` 可调用、同名覆盖情况
- 作用域：每行一个**二选一控件**——「全局」或「本项目」，二者互斥：
  - 选「本项目」= 全局那份 frontmatter 停用 + 在 `<项目>/.dsh/skills/<name>` 复制一份**启用**的副本（内容两份，之后各自独立）；
  - 选「全局」= 把项目副本移进回收目录 + 全局那份恢复启用。
  - 项目里本来没有全局对应物的技能，选「全局」即提升为全局；旧的「占位」行选中「全局」即恢复。
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
2. **向 DSH 注册表核对**：宿主通过 `ctx.get('skills')` 拿到 DSH 的技能注册表。`/list` 给每一行标注 `dsh.state`，取值有三种：`loaded`（DSH 生效的正是这一份）、`other`（DSH 生效的是别处同名技能）、`missing`（DSH 没加载）。导入结果也逐条带 `dsh`。完整 YAML 语法错误（例如值里有未加引号的 `: `）靠这一关发现。每次写操作成功后，宿主都会调用一次 `invalidateCache()`，DSH 会立刻重扫，不必等目录监听的稳定期。拿不到注册表时，面板照常工作，只是不做标注（`dshChecked: false`）。

### 作用域切换是怎么落盘的

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
| POST | `/scope` | 作用域双向切换（全局 ⇄ 本项目，含副本复制与全局停用/恢复） |
| POST | `/create` | 新建技能（全局或本项目） |
| POST | `/delete` | 移到回收目录 |
| POST | `/import-folder` | 从本地目录导入 |
| POST | `/import-zip` | 从 zip 导入（自实现的最小 zip 读取，store/deflate；拒绝 zip64 与路径穿越） |

`project` 缺省时取最近一个会话的工作目录，其次取工作区注册表的第一个。

## 安全边界

- 只接受 loopback 同源请求（`sec-fetch-site: cross-site` 一律 403，带 Origin 时要求 loopback 且与 Host 同源）。
- 写操作先按 root 重新定位技能，不看客户端传的路径；删除前再校验目标确实位于某个技能根目录之内。
- 导入：zip ≤32MB、解压后 ≤64MB、条目 ≤2000，路径穿越直接拒绝；目标已存在同名技能时不覆盖。
- 占位删除只认本插件写的标记。

## 安装

已在 `desktop` profile 里装为本目录的 link（entry id：`include:dsh-skill-panel`）：

```powershell
# 装 / 重装
plugin_manager install_bundle --target C:\Users\lenovo\Documents\DSH-Workspace\dsh-skill-panel
# 改完代码：换模块代次（客户端半区要刷新页面）
plugin_manager set_plugin --target include:dsh-skill-panel --enabled false
plugin_manager set_plugin --target include:dsh-skill-panel --enabled true
```

卸载：`plugin_manager remove_bundle --target dsh-skill-panel`。

## 测试

```powershell
node --test test/host.test.mjs test/apply.test.mjs
```

- `test/host.test.mjs`：frontmatter 解析 / 布尔语法 / 开关改写 / 两层去重 / 占位 / 导入 / 自造 zip / 与 DSH 加载器同口径的校验
- `test/apply.test.mjs`：假 ctx 真跑 `apply()`，验证 9 条路由都注册、`/list` 出数、flags/create/save/delete 真的落盘、跨站请求 403、错方法 405、向 DSH 注册表核对加载状态

## 已知限制

- 「本项目禁用」依赖同名占位覆盖：如果项目里本来就有同名技能，面板会拒绝而不是覆盖。
- 只扫面板认得的四个默认根；宿主 `customSkillDirs` 里挂的技能不在列表里（宁可漏报也不误报）。
- 预设层（preset 自带、经作用域挂载的技能）不显示；面板只读写磁盘上的项目层与全局层。
- 删除是移到 `~/.dsh/skill-panel-trash/`，不自动清理。
- zip 只认根级 `SKILL.md` 或一层目录 `<dir>/SKILL.md`；更深的嵌套（如 `repo-main/skills/foo/SKILL.md`）会被拒绝并提示「压缩包里没有技能」。
- DSH 加载状态只核对每个名字的生效那一份；被覆盖的副本能否被 DSH 解析不做标注。
- 面板界面文案是中文硬编码（未经过 Client locale 服务）；插件元数据有 zh/en 两份。
