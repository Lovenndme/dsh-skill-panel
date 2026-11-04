# dsh-skill-panel 交接说明（给 DSH 开发智能体）

你是 DSH 的开发智能体。请接手并收尾插件 dsh-skill-panel（「设置 → 技能」页的技能管理面板）。下面是交接说明。请先读代码，并在真实运行环境里核实，再动手。每一项最后都给出结论：已修复 / 确认无需修改 / 需要用户决定。

## 一、项目现状

- 目录：`C:\Users\lenovo\Documents\DSH-Workspace\dsh-skill-panel`（git 仓库）。HEAD `b706e2c` 是改版前的快照。当前有若干文件改动未提交：`client.js`、`index.js`、`lib/skills.js`、`test/apply.test.mjs`、`test/host.test.mjs`、`README.md`、`HANDOFF.md`。建议先提交一次存档再改。
- 结构：`index.js` + `lib/skills.js` 是宿主半区（路由 `/api/dsh-skill-panel/*`）；`client.js` 是浏览器半区（`settings.section` 插槽，用 `React.createElement`，没有构建步骤）。
- 测试：`node --test test/host.test.mjs test/apply.test.mjs`，目前 37/37 通过。
- 生效方式：改宿主半区要重启 DSH（或在插件页停用再启用）；只改 `client.js` 刷新页面即可。
- 用户已在真实环境确认可用：面板布局（操作时设置弹窗不再上下跳）、作用域切换、删除确认、「启用」开关、导入、Markdown 预览。
- 最近一次改动：项目下拉框从原生 `<select>` 换成了自绘的选择器（`ProjectPicker`，按 WAI-ARIA APG 的 select-only combobox 模式实现），还没在真实环境确认，见第六项。

## 二、必须修：「DSH 加载状态」核对在 DSH 0.2.x 下不成立

- 现象：切换一次颜色主题后（这会改写 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `ui-theme.preference` 并触发插件重载），面板把 6 个全局技能全部标成「DSH 未加载」，重启 DSH 后依旧。但在新会话里输入 `/`，这些技能都在。
- 根因：`index.js` 用 `ctx.get('skills')` 拿到 DSH 技能注册表后，调用 `snapshot({ cwd })`，没有传 `scope`。而在 0.2.1-rc.5 里，`@deepseek-ai/dsh-skill-filesystem` 是挂在每个 agent preset 的 `plugins` 列表里的（见 `dsh-web-app/presets/standard.patch.yml`、`ptc.patch.yml`、`cordis.patch.yml`，以及用户自定义的 `~/.dsh/.agent-presets/liangshen/agent.cordis.yml`），随 Agent 实例加载，provider 注册在 preset / agent 作用域那一层，不在全局层。不带 scope 的查询只能看到全局层。
- 证据：`GET /api/dsh-skill-panel/list` 返回的 `dshProbe` 是 `verdict=no-local-skills`、`total=8`、`bySource={bundled:8}`、`byProvider={dsh-office:7, dsh-windows-acl:1}`、`complete=true`。DSH-Workspace 和 pmis-agent 两个项目结果一样。
- 当前的缓解措施：`dshCatalog` 里加了判定，结果里没有任何本地来源（project-dsh / project-agents / user-dsh / user-agents）时视为「无法核对」，不做逐行标注。所以现在不会误报，但这项核对在当前 DSH 上也从来不会生效。另外，每次 POST 成功后 `guard` 都会调用 `registry.invalidateCache()`，请一并评估是否保留。
- 请在下面两条路里选一条实现：
  - A. 如果 DSH 有受支持的方式拿到「某个预设或会话所见的技能」（比如 `/` 命令列表走的那条路径），就改成按这个视图核对，并定下界面语义：是按默认预设算，还是任一预设加载了就算加载。
  - B. 如果没有，就删掉注册表核对：`index.js` 里的 `dshRegistry` / `refreshDsh` / `dshCatalog` / `dshStateOf` / `annotateWritten`，`/list` 返回里的 `dshChecked` / `dshProbe`，`client.js` 里的 `dshProblem` 标签和导入结果中的 DSH 状态。然后按第三项补全本地校验。
- 验收：面板说某个技能「DSH 不会加载」，当且仅当 DSH 的会话里确实看不到它。

## 三、本地校验的缺口：YAML 语法错误

- `lib/skills.js` 的 `parseFrontmatterFields` 是简化解析器，只认顶层的 `key: value` 和 `|` / `>` 块标量。`inspectSkillDoc` 已经和 dsh-skill-filesystem 对齐了以下几条：缺 `name`；出现旧键 `userInvocable` / `modelInvocable` / `disableModelInvocation`；`name` 或 `description` 会被 YAML 读成非字符串；顶层键重复。
- 仍然存在「面板接受、DSH 忽略」的写法，例如：
  - 普通标量里有没加引号的「: 」，比如 `description: Use when: X`（yaml 报错 `Nested mappings are not allowed in compact mappings`）；
  - 普通标量的缩进续行里含「: 」；
  - 引号闭合后还跟着内容，或者引号没闭合；
  - 值以 `[` `{` `*` `@` `` ` `` 等 YAML 指示符开头；
  - 顶层出现不是 `key: value` 形式的行。
- 建议：逐条写规则，每条都用 DSH 自带的 yaml（2.9.1）逐例对拍。最好再用 dsh-skill-filesystem 的 `parseSkillFile` 跑一遍端到端，确保面板和 DSH 的判定一致。导入时遇到这类问题直接拒绝并说明原因；磁盘上已有的坏文件放进 `/list` 的 `diagnostics`，也就是界面底部的「无法读取」。

## 四、安全：插件路由没有鉴权

- `index.js` 的 `isTrusted` 在请求没有 `Origin` 头时直接放行。实测本机任何进程（比如 curl）都能直接调用 `/api/dsh-skill-panel/*`，包括 save、delete、scope、import 这些写接口。而同类插件 skill-explorer 的路由会返回 401（它通过 `remoteWebUiPairing` 做了信任校验）。
- 请改用 DSH 的标准鉴权 / 信任机制，确保只有已登录的 Web UI 能调用这些接口。

## 五、需要确认的宿主接口

- 预览复用了 Web 外壳共享模块表（`OZ()`）里 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`（参数有 `text`、`labels`、`variant` 等）。它不是文档化的插件 API。请确认第三方插件能否依赖它；如果有官方方式，就换成官方方式。目前的兜底是：`require` 失败或渲染出错时，由 `MarkdownBoundary` 退回纯文本显示。
- 预览里的 http 链接：外面没有包 `MarkdownDelegateProvider` 时，`MarkdownText` 会把它渲染成 `target=_blank` 的 `<a>`。请确认桌面端点击后是否用外部浏览器打开；如果有官方的 `openExternalLink`，就包一层 `MarkdownDelegateProvider`。

## 六、只在模拟环境验证过，需要在真实环境核实

- 浅色主题：配色都用 `--dsw-alias-*` 变量，但有两个硬编码兜底色（`#ececf1`、`#16161a`）和 rgba 阴影 / 遮罩，目前只在深色主题下看过。
- Esc：焦点在面板内、且有可关闭的弹层时，面板会在 window 捕获阶段拦截 Esc，避免把设置弹窗一起关掉。请确认这和设置弹窗自身的实现不冲突。
- 面板高度：`clamp(360px, calc(100vh - 210px), 700px)`，所有弹层都用 `position:absolute` 画在面板内部。请在小窗口下确认设置弹窗外层不会出现滚动条。
- 弹层打开时，`client.js` 通过 ref 给背景加 `inert`，让背景不可聚焦（React 18）。
- 项目选择器（`ProjectPicker`）：点击展开、↑↓ / Home / End / Enter / 空格 / Esc、点外面关闭；浮层宽 300px，画在面板内部，每项两行显示「项目名 + 路径」。请在真实环境确认它的外观、`document` 上捕获阶段 mousedown 的「点外面关闭」，以及和设置弹窗焦点管理之间的配合。

## 七、可选功能

- zip / 文件夹导入支持 GitHub「Download ZIP」那种多层嵌套结构（`repo-main/skills/foo/SKILL.md`）。目前只认根级的 `SKILL.md` 或一层目录。
- 回收目录 `~/.dsh/skill-panel-trash/` 目前没有界面，可以加恢复和清理功能。

## 约束（来自用户，务必遵守）

- 界面文案用中文；不写解释性说明文字，只保留数据、标签、控件和错误信息。
- 颜色只用 `--dsw-alias-*` 主题变量。注意：深色主题下 `brand-primary` 是白色，`bg-overlay` 是半透明浅色，都不能当实心底色用。
- 不新增依赖，不引入构建工具，不加外部样式表或 CDN。`client.js` 保持单文件，保持 `window.__ModuleLoader__.load` 的入口形状；样式用组件内 `<style>`，类名统一加 `dskp-` 前缀。
- 面板高度必须固定：设置弹窗按内容高度垂直居中，面板高度一变，整个窗口就会上下跳。
- 测试时不要读写 `~/.dsh/skills` 和 `~/.dsh/skill-panel-trash` 下的真实技能文件，一律用临时目录。
- 用户偏好：状态提示只在异常时出现，控件越少越好。
- 改完跑测试；如果改了宿主半区，提醒用户重启 DSH。

## 收尾记录（DSH 开发智能体，2026-11-04 17:0x）

### 第二项：已修复（真机上验证过）

- 改为按 preset 作用域核对：`ctx.get('agentPresets')` → `list()` → 对每个 preset
  `acquireScope(id)` 取 `{ key }` → `ctx.skills.snapshot({ cwd, scope: key })`，
  用完在 `finally` 里 `await lease[Symbol.asyncDispose]()`；任一 preset 看到同名技能即视为会被加载（union 语义）。
  `broken` 的 preset 跳过；所有 preset 都看不到本地技能时再退回一次全局层快照，避免把「作用域没挂上」误判成「都没加载」。
- 实测（本机，DSH-Workspace）：`verdict=checked`、`method=snapshot-scoped`、`scope=preset-union`、去重后 18 个名字；
  逐 preset：`standard 14/本地6`、`ptc 14/6`、`minimal 8/0`、`cordis 18/6`、`yuike 8/0`（后两者没挂技能链，符合它们的 patch）。
  一次 `/list` 约 240ms。
- 加了 2 秒的面板侧缓存（按 cwd），所有 POST 成功后清空缓存；**不要**再用 `registry.invalidateCache()`：
  `ctx.skills` 的公开契约只有 `registerProvider / register / list / snapshot / get`，没有这个方法，
  旧代码里的 `refreshDsh` 实际是空操作，已删除。
- 保留 `probe.verdict` 的四种判定：只有 `checked` 才逐行标注，`incomplete` / `no-local-skills` / `error` 一律不标（宁可不标也不误报）。

### 第四项：已修复

- `guard` 改为优先走 DSH 官方信任围栏：`ctx.get('connection').requestRejection({ headers: req.headers })`，
  返回 401/403 就直接回，不再自己判断；只有在 composition 里没有 `connection` 服务时才退回原来的 loopback 判断。
- 实测：改之前本机 `curl`（无 cookie）能读能写；改之后 `GET /list`、`POST /create` 都返回 **401**，浏览器页面同源请求带签名 cookie 可以正常通过。

### 第三项：未改，但已降级为「可观测」

- 本地仍不做完整 YAML 语法校验。`yaml` 包从插件目录 `require.resolve` 解析不到（MODULE_NOT_FOUND），
  而约束是不许加依赖，所以没有引入。
- 现在注册表核对可用了，这类「面板接受、DSH 忽略」的文件会以逐行「DSH 未加载」的形式暴露出来，不再是静默不一致。
- 若要做严格校验，建议在宿主侧用 DSH 自带的 yaml 对拍，并把规则限定在「确定非法」的写法上，避免误拒合法文件。

### 第五项：结论

- `MarkdownText` 确实不是文档化插件 API。当前实现已经在 `try/catch` 里取，取不到或渲染失败退回纯文本，可以接受；
  不建议再扩大对 `dsh-client-ui-primitives` 的依赖面。若要长期稳定，后续可换成纯文本 + 外部打开。

### 第六、七项：保持原状

- 浅色主题、Esc 捕获、`inert` 背景、ProjectPicker 的点外关闭、小窗口高度：都属于「模拟环境验证过、真实环境未确认」，本次没动。
- 多层 zip 结构与回收目录界面：未做。

### 测试与状态

- `node --test test/host.test.mjs test/apply.test.mjs`：**37/37 通过**。
  新增断言覆盖：按 preset 取作用域、租约释放、`broken` preset 跳过、写操作后必须重新取快照（不吃旧缓存）。
- 改动文件：`index.js`（DSH 核对段与 guard）、`test/apply.test.mjs`。`client.js` / `lib/skills.js` 本轮未改。

## 追加问题（2026-11-04，用户实测后提出）

> **状态：两项都已修复（Claude Code，2026-11-04），DSH 侧不需要再改。** 做法如下：
> - `addSummaries` 改为按名字收集所有 preset 的胜出者（`winners: name → summary[]`）。`dshStateOf` 判定规则：任一 preset 里生效的正是这一份，就是 `loaded`；都不是才判 `other`；一个都没有才判 `missing`。
> - 新增 `settleDsh` 和 `finishWrite`：save、flags、scope、create、delete、import 写完后，以面板自己扫描磁盘的结果作为期望值，每 150ms 重读一次各 preset 的快照，直到 DSH 视图反映出这一份文件（含两个开关），最多等 1.5s。读到的新结果直接放进面板缓存，紧接着的 `/list` 复用它，不会再多读一次；`/list` 返回的 `dshProbe.settle` 里记录了重读的轮数和耗时。整个过程不调用 `invalidateCache()`。
> - 测试：新增「多个 preset 胜出者不同」「写后等 DSH 追上」两条（已用变异测试确认：退回旧逻辑时这两条都会失败）。`node --test test/host.test.mjs test/apply.test.mjs` 39/39 通过。

### 一、写操作后马上核对，结果偏旧，短暂误报「未生效」

- 现象：在 pmis-agent 把 `apifox-sync` 从全局切到本项目后，该行显示红色「未生效」（`dsh.state = other`，指向 `~/.dsh` 那份）。过一会儿手动刷新，标签就消失了。在这段时间里，技能实际生效的一直是项目副本。
- 原因：`POST /scope` 写完立即返回，前端紧接着发 `GET /list`。这时 DSH 的 skill-filesystem 目录监听还没来得及让注册表缓存失效：chokidar 有约 200ms 的 `awaitWriteFinish`，目录原本不存在时用祖先目录 `watchFile` 轮询。所以 `snapshot` 拿到的是写入之前的视图。原先 guard 里的 `registry.invalidateCache()` 已经删掉，面板侧那 2 秒缓存只清面板自己的，清不到 DSH 注册表。
- 建议修复（按优先顺序，可以组合使用）：
  1. 如果 DSH 有公开的方式「等待技能目录的变更生效」或主动刷新，优先用它。
  2. 写操作（scope / create / delete / import / save / flags）成功后，返回前等注册表追上：对受影响的技能名，轮询相关 preset 的 `snapshot`（间隔约 150ms，最多约 1.5s），直到结果和预期一致。例如 scope 切到 project 后，winner 应是 `project-dsh` 且路径匹配；delete 之后，winner 不应再是被删的那份。超时就照常返回。
  3. 兜底：`/list` 对「最近几秒内被面板写过的技能」，如果核对结果不是 `loaded`，先当作「待定」不打标签；前端在操作完成约 1 秒后再静默刷新一次。
- 验收：切换作用域、新建、删除、导入之后，不用手动刷新，也不会出现「未生效 / DSH 未加载」的瞬时误报；真正有问题的技能仍然能标出来。

### 二、多个 preset 合并时，只保留了第一个 preset 的结论

- `addSummaries` 里用的是 `if (!byName.has(name)) byName.set(name, summary)`。同名技能在不同 preset 里的 winner 不一样时，只会取排在第一个的（目前 standard 在最前面）。这和「任一 preset 能看到就算会被加载」的语义不符。例如 cordis（创造模式）额外挂了 `dsh-agent-preset/skills` 作为 custom 根，rank 300，会压过 user-dsh 的 400，所以同名时各 preset 的 winner 本来就可能不同。
- 建议：按名字收集所有 preset 的 winner（name → summaries[]）。`dshStateOf` 改为：只要任一 winner 的 source + path 和本行一致，就判为 `loaded`；都不一致才判 `other`；一个都没有才判 `missing`。
- 验收：补一条测试，覆盖「两个 preset 的 winner 不同」的情况。
