/**
 * dsh-skill-panel — 浏览器半区（v2，重做 UI）。
 *
 * 设计要点：
 *   - 面板高度固定（外层 100% + 内部滚动），状态反馈只走绝对定位 toast，
 *     所以任何操作都不会改变面板高度 → 设置弹窗不会重新居中 → 不再整窗抖动。
 *   - 行高统一：描述 2 行截断、路径 1 行省略、右侧控件列固定宽度。
 *   - 两个开关的语义严格区分：
 *       全局   = 这份技能在全局层是否允许模型调用（写 ~/.dsh/skills 的 SKILL.md）
 *       本项目 = 这份技能在本项目是否可用（全局技能靠同名占位，项目技能靠自己的 frontmatter）
 *     全局层关掉模型调用，不会让「本项目」跟着显示成关闭（旧版这里串了）。
 *   - 数据全部来自宿主 /api/dsh-skill-panel/*，这里不自己扫磁盘。
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/api/dsh-skill-panel'
    const PROJECT_KEY = 'dsh-skill-panel.project'

    const CSS = `
.dsp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:360px;max-height:calc(100vh - 190px);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}
.dsp-root *,.dsp-root *::before,.dsp-root *::after{box-sizing:border-box}
.dsp-root :focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.dsp-toolbar{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsp-grow{flex:1 1 auto;min-width:90px}
.dsp-input,.dsp-select{height:30px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 8px;font:inherit;font-size:12px;box-sizing:border-box}
.dsp-select{flex:0 0 168px;max-width:168px}
.dsp-input::placeholder{color:var(--dsw-alias-state-idle-primary)}
.dsp-btn{height:30px;padding:0 11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.dsp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsp-btn:disabled{opacity:.45;cursor:default}
.dsp-btnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent;font-weight:600}
.dsp-btnPrimary:hover:not(:disabled){border-color:transparent;filter:brightness(.94)}
.dsp-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsp-btnTiny{height:26px;padding:0 8px;font-size:11px}
.dsp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 2px 4px;margin-right:-4px;padding-right:6px}
.dsp-group{margin-bottom:16px}
.dsp-groupHead{display:flex;align-items:baseline;gap:8px;padding:0 2px 6px}
.dsp-groupTitle{font-size:12px;font-weight:600;letter-spacing:.01em;flex:0 0 auto}
.dsp-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto}
.dsp-rootPath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;text-align:right;min-width:0}
.dsp-row{display:grid;grid-template-columns:minmax(0,1fr) 192px;gap:14px;align-items:center;padding:8px 8px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.dsp-group .dsp-row:last-child{border-bottom:0}
.dsp-row:hover{background:var(--dsw-alias-bg-layer-1)}
.dsp-main{min-width:0;display:flex;flex-direction:column;gap:3px}
.dsp-idLine{display:flex;align-items:center;gap:8px;min-width:0}
.dsp-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsp-chips{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dsp-chip{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsp-chipWarn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsp-flags{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsp-flag{display:inline-flex;align-items:center;gap:5px}
.dsp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.dsp-dotOn{background:var(--dsw-alias-state-success-primary)}
.dsp-desc{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsp-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-state-idle-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsp-ctl{display:flex;flex-direction:column;gap:6px;align-items:stretch;justify-self:end;width:192px}
.dsp-scope{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%}
.dsp-scopeSide{background:transparent;border:0;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dsp-scopeSide:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsp-scopeSide:disabled{opacity:.45;cursor:default}
.dsp-scopeSideOn{color:var(--dsw-alias-label-primary);font-weight:600}
.dsp-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dsp-switch:disabled{opacity:.45;cursor:default}
.dsp-switchOn{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.dsp-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
.dsp-switchOn .dsp-knob{transform:translateX(16px)}
.dsp-pill{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;min-width:0}
.dsp-pill:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsp-pill:disabled{opacity:.45;cursor:default}
.dsp-pillOn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsp-pillOn:hover:not(:disabled){color:var(--dsw-alias-state-success-primary)}
.dsp-actionRow{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dsp-empty{padding:12px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsp-skel{height:64px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));background-size:200% 100%;animation:dspShimmer 1.4s ease-in-out infinite;margin-bottom:8px;opacity:.7}
@keyframes dspShimmer{0%{background-position:0% 0}100%{background-position:-200% 0}}
.dsp-errorBox{padding:10px 8px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsp-diag{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsp-diag summary{cursor:pointer;padding:4px 2px}
.dsp-diagList{margin:4px 0 0;padding-left:16px;word-break:break-all}
.dsp-toast{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);max-width:86%;padding:7px 12px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 22px rgba(0,0,0,.3);font-size:12px;color:var(--dsw-alias-label-primary);z-index:9;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsp-toastError{color:var(--dsw-alias-state-error-primary)}
.dsp-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:70;padding:24px}
.dsp-modal{width:min(780px,100%);max-height:84vh;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.4)}
.dsp-modalHead{display:flex;align-items:flex-start;gap:10px;flex:0 0 auto}
.dsp-modalMeta{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:3px}
.dsp-modalTitle{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsp-modalPath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-state-idle-primary);word-break:break-all}
.dsp-modalBody{display:flex;flex-direction:column;gap:10px;min-height:0;flex:1 1 auto}
.dsp-field{display:flex;flex-direction:column;gap:4px}
.dsp-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsp-textarea{width:100%;min-height:240px;flex:1 1 auto;resize:vertical;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55}
.dsp-toggleGroup{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;flex:0 0 auto}
.dsp-seg button{height:26px;padding:0 11px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsp-seg button.dsp-segOn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsp-modalFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto}
.dsp-footNote{flex:1 1 auto;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:left;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsp-list{margin:0;padding-left:16px;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsp-listItemError{color:var(--dsw-alias-state-error-primary)}
`

    /* ------------------------------------------------------------------ 网络 */

    async function request(url, options) {
      const response = await fetch(url, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const reason = payload && Array.isArray(payload.errors) ? payload.errors.join('；') : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return payload
    }

    const getJson = (url) => request(url, { headers: { accept: 'application/json' } })

    function withParams(base, params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text ? `${base}?${text}` : base
    }

    const postJson = (url, body) =>
      request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

    /* -------------------------------------------------------------- 本地状态 */

    function readProject() {
      try {
        return window.localStorage.getItem(PROJECT_KEY) || ''
      } catch {
        return ''
      }
    }

    function writeProject(value) {
      try {
        if (value) window.localStorage.setItem(PROJECT_KEY, value)
      } catch {
        /* 无痕模式忽略 */
      }
    }

    /* ---------------------------------------------------------------- 小工具 */

    function layerOf(skill) {
      if (skill.scope === 'global') return skill
      return (skill.shadowed || []).find((item) => item.scope === 'global') || null
    }

    function sourceChip(skill) {
      if (skill.stub) return { label: '本项目禁用', tone: 'warn' }
      if (skill.source === 'user-dsh') return { label: '全局' }
      if (skill.source === 'user-agents') return { label: '全局 ~/.agents' }
      if (skill.source === 'project-dsh') return { label: '本项目' }
      return { label: '本项目 .agents' }
    }

    function zipSkillName(fileName) {
      return String(fileName || '')
        .replace(/\.zip$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    }

    /* ---------------------------------------------------------------- 组件 */

    function Pill({ label, checked, disabled, title, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsp-pill' + (checked ? ' dsp-pillOn' : ''),
          'aria-pressed': checked ? 'true' : 'false',
          title: title || undefined,
          disabled: !!disabled,
          onClick,
        },
        h('span', { className: 'dsp-dot' + (checked ? ' dsp-dotOn' : '') }),
        label,
      )
    }

    function FlagDots({ modelInvocable, userInvocable }) {
      return h(
        'div',
        { className: 'dsp-flags' },
        h('span', { className: 'dsp-flag' }, h('span', { className: 'dsp-dot' + (modelInvocable ? ' dsp-dotOn' : '') }), '模型'),
        h('span', { className: 'dsp-flag' }, h('span', { className: 'dsp-dot' + (userInvocable ? ' dsp-dotOn' : '') }), '命令'),
      )
    }

    function ScopeSwitch({ value, disabled, title, onChange }) {
      const isGlobal = value === 'global'
      return h(
        'div',
        { className: 'dsp-scope', title: title || undefined },
        h(
          'button',
          {
            type: 'button',
            className: 'dsp-scopeSide' + (isGlobal ? ' dsp-scopeSideOn' : ''),
            disabled: !!disabled,
            onClick: () => {
              if (!isGlobal) onChange('global')
            },
          },
          '全局',
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': isGlobal ? 'false' : 'true',
            'aria-label': '全局 / 本项目',
            className: 'dsp-switch' + (isGlobal ? '' : ' dsp-switchOn'),
            disabled: !!disabled,
            onClick: () => onChange(isGlobal ? 'project' : 'global'),
          },
          h('span', { className: 'dsp-knob' }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsp-scopeSide' + (isGlobal ? '' : ' dsp-scopeSideOn'),
            disabled: !!disabled,
            onClick: () => {
              if (isGlobal) onChange('project')
            },
          },
          '本项目',
        ),
      )
    }

    function SkillRow({ skill, busy, pendingDelete, onScope, onOpen, onDelete }) {
      const layer = layerOf(skill)
      const chip = sourceChip(skill)
      const isStub = !!skill.stub
      const shadowed = skill.shadowed || []
      const selected = isStub ? 'global' : skill.scope
      const scopeTitle = isStub
        ? '切换把这份技能放回全局（会删除本项目占位）'
        : selected === 'global'
          ? '切到「本项目」：全局那份停用，仅本项目保留一份启用的副本'
          : '切到「全局」：删掉本项目副本，恢复全局那份（所有项目可用）'

      return h(
        'div',
        { className: 'dsp-row' },
        h(
          'div',
          { className: 'dsp-main' },
          h(
            'div',
            { className: 'dsp-idLine' },
            h('span', { className: 'dsp-name', title: skill.name }, skill.name),
            h(
              'div',
              { className: 'dsp-chips' },
              h('span', { className: 'dsp-chip' + (chip.tone === 'warn' ? ' dsp-chipWarn' : '') }, chip.label),
              shadowed.length ? h('span', { className: 'dsp-chip', title: shadowed.map((item) => item.path).join('\n') }, `覆盖 ${shadowed.length}`) : null,
            ),
          ),
          h(FlagDots, { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable }),
          h('div', { className: 'dsp-desc' }, skill.description),
          h(
            'div',
            { className: 'dsp-path', title: isStub && layer ? `${skill.path} → ${layer.path}` : skill.path },
            isStub && layer ? `${skill.path} → ${layer.path}` : skill.path,
          ),
        ),
        h(
          'div',
          { className: 'dsp-ctl' },
          h(ScopeSwitch, {
            value: selected,
            disabled: busy,
            title: scopeTitle,
            onChange: (next) => onScope(skill, next),
          }),
          h(
            'div',
            { className: 'dsp-actionRow' },
            h('button', { type: 'button', className: 'dsp-btn dsp-btnTiny', onClick: () => onOpen(skill) }, '查看'),
            h(
              'button',
              {
                type: 'button',
                className: 'dsp-btn dsp-btnTiny' + (pendingDelete ? ' dsp-btnDanger' : ''),
                disabled: busy,
                onClick: () => onDelete(skill),
              },
              pendingDelete ? '确认删除' : '删除',
            ),
          ),
        ),
      )
    }

    function Group({ title, count, rootPath, children, emptyText }) {
      return h(
        'div',
        { className: 'dsp-group' },
        h(
          'div',
          { className: 'dsp-groupHead' },
          h('span', { className: 'dsp-groupTitle' }, title),
          h('span', { className: 'dsp-count' }, String(count)),
          rootPath ? h('span', { className: 'dsp-rootPath', title: rootPath }, rootPath) : null,
        ),
        count ? children : h('div', { className: 'dsp-empty' }, emptyText),
      )
    }

    function Toast({ toast }) {
      if (!toast) return null
      return h('div', { className: 'dsp-toast' + (toast.error ? ' dsp-toastError' : '') }, toast.text)
    }

    /* ------------------------------------------------------------ 详情弹窗 */

    function DetailModal({ item, project, onClose, onSaved }) {
      const [content, setContent] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [flags, setFlags] = useState({
        modelInvocable: !!item.flags.modelInvocable,
        userInvocable: !!item.flags.userInvocable,
      })

      const loadDoc = useCallback(async () => {
        setError(null)
        try {
          const data = await getJson(withParams(`${API}/doc`, { project, name: item.name, source: item.source }))
          setContent(data.content || '')
          setLoaded(true)
          setDirty(false)
        } catch (failure) {
          setError(failure.message)
        }
      }, [item.name, item.source, project])

      useEffect(() => {
        loadDoc()
      }, [loadDoc])

      const save = async () => {
        setBusy(true)
        setError(null)
        try {
          await postJson(withParams(`${API}/save`, { project }), { name: item.name, source: item.source, content })
          setDirty(false)
          await loadDoc()
          await onSaved()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const toggleFlag = async (field, value) => {
        const previous = flags
        setFlags({ ...flags, [field]: value })
        setBusy(true)
        setError(null)
        try {
          await postJson(withParams(`${API}/flags`, { project }), { name: item.name, source: item.source, [field === 'modelInvocable' ? 'model' : 'user']: value })
          await onSaved()
        } catch (failure) {
          setFlags(previous)
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsp-backdrop', onClick: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dsp-modal', role: 'dialog', 'aria-label': item.name },
          h(
            'div',
            { className: 'dsp-modalHead' },
            h(
              'div',
              { className: 'dsp-modalMeta' },
              h('div', { className: 'dsp-modalTitle' }, item.name),
              h('div', { className: 'dsp-modalPath' }, item.path),
            ),
            h('button', { type: 'button', className: 'dsp-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'dsp-toggleGroup' },
            h(Pill, {
              label: '模型可调用',
              checked: flags.modelInvocable,
              disabled: busy,
              onClick: () => toggleFlag('modelInvocable', !flags.modelInvocable),
            }),
            h(Pill, {
              label: '命令可调用',
              checked: flags.userInvocable,
              disabled: busy,
              onClick: () => toggleFlag('userInvocable', !flags.userInvocable),
            }),
            h('button', { type: 'button', className: 'dsp-btn', disabled: busy, onClick: loadDoc }, '重新读取'),
          ),
          error ? h('div', { className: 'dsp-errorBox' }, error) : null,
          h(
            'div',
            { className: 'dsp-modalBody' },
            loaded
              ? h('textarea', {
                  className: 'dsp-textarea',
                  value: content,
                  spellCheck: false,
                  onChange: (event) => {
                    setContent(event.target.value)
                    setDirty(true)
                  },
                })
              : h('div', { className: 'dsp-empty' }, '读取中…'),
          ),
          h(
            'div',
            { className: 'dsp-modalFoot' },
            h('span', { className: 'dsp-footNote' }, dirty ? '未保存' : ''),
            h('button', { type: 'button', className: 'dsp-btn', disabled: busy || !dirty, onClick: loadDoc }, '放弃修改'),
            h('button', { type: 'button', className: 'dsp-btn dsp-btnPrimary', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ 新建弹窗 */

    function CreateModal({ project, hasProject, onClose, onDone }) {
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [scope, setScope] = useState('project')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          await postJson(withParams(`${API}/create`, { project }), { name: name.trim(), description: description.trim(), scope })
          await onDone(`已新建 ${name.trim()}`)
          onClose()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsp-backdrop', onClick: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dsp-modal', role: 'dialog', 'aria-label': '新建技能' },
          h(
            'div',
            { className: 'dsp-modalHead' },
            h('div', { className: 'dsp-modalMeta' }, h('div', { className: 'dsp-modalTitle' }, '新建技能')),
            h('button', { type: 'button', className: 'dsp-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'dsp-toggleGroup' },
            h(
              'div',
              { className: 'dsp-seg' },
              h('button', { type: 'button', className: scope === 'project' ? 'dsp-segOn' : '', disabled: !hasProject, onClick: () => setScope('project') }, '本项目'),
              h('button', { type: 'button', className: scope === 'global' ? 'dsp-segOn' : '', onClick: () => setScope('global') }, '全局'),
            ),
          ),
          h(
            'div',
            { className: 'dsp-field' },
            h('span', { className: 'dsp-label' }, 'name'),
            h('input', { className: 'dsp-input', value: name, placeholder: 'my-skill', onChange: (event) => setName(event.target.value) }),
          ),
          h(
            'div',
            { className: 'dsp-field' },
            h('span', { className: 'dsp-label' }, 'description'),
            h('input', { className: 'dsp-input', value: description, onChange: (event) => setDescription(event.target.value) }),
          ),
          error ? h('div', { className: 'dsp-errorBox' }, error) : null,
          h(
            'div',
            { className: 'dsp-modalFoot' },
            h('button', { type: 'button', className: 'dsp-btn', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'dsp-btn dsp-btnPrimary', disabled: busy, onClick: submit }, busy ? '创建中…' : '创建'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ 导入弹窗 */

    function ImportModal({ project, hasProject, onClose, onDone }) {
      const [mode, setMode] = useState('folder')
      const [scope, setScope] = useState('project')
      const [folder, setFolder] = useState('')
      const [file, setFile] = useState(null)
      const [results, setResults] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const fileRef = useRef(null)

      const submit = async () => {
        setBusy(true)
        setError(null)
        setResults(null)
        try {
          if (mode === 'folder') {
            const data = await postJson(withParams(`${API}/import-folder`, { project }), { sourcePath: folder.trim(), scope })
            setResults(data.results || [])
          } else {
            if (!file) throw new Error('先选一个 zip 文件')
            const buffer = await file.arrayBuffer()
            const response = await fetch(withParams(`${API}/import-zip`, { project, scope, name: zipSkillName(file.name) }), {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: buffer,
            })
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (!response.ok || (payload && payload.ok === false)) {
              throw new Error(payload && payload.errors ? payload.errors.join('；') : `HTTP ${response.status}`)
            }
            setResults(payload.results || [])
          }
          await onDone()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsp-backdrop', onClick: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dsp-modal', role: 'dialog', 'aria-label': '导入技能' },
          h(
            'div',
            { className: 'dsp-modalHead' },
            h('div', { className: 'dsp-modalMeta' }, h('div', { className: 'dsp-modalTitle' }, '导入技能')),
            h('button', { type: 'button', className: 'dsp-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'dsp-toggleGroup' },
            h(
              'div',
              { className: 'dsp-seg' },
              h('button', { type: 'button', className: scope === 'project' ? 'dsp-segOn' : '', disabled: !hasProject, onClick: () => setScope('project') }, '本项目'),
              h('button', { type: 'button', className: scope === 'global' ? 'dsp-segOn' : '', onClick: () => setScope('global') }, '全局'),
            ),
            h(
              'div',
              { className: 'dsp-seg' },
              h('button', { type: 'button', className: mode === 'folder' ? 'dsp-segOn' : '', onClick: () => setMode('folder') }, '文件夹'),
              h('button', { type: 'button', className: mode === 'zip' ? 'dsp-segOn' : '', onClick: () => setMode('zip') }, 'zip'),
            ),
          ),
          mode === 'folder'
            ? h('input', {
                className: 'dsp-input',
                value: folder,
                placeholder: 'D:\\skills\\my-skill',
                onChange: (event) => setFolder(event.target.value),
              })
            : h('input', {
                type: 'file',
                accept: '.zip,application/zip',
                ref: fileRef,
                onChange: (event) => setFile(event.target.files && event.target.files[0] ? event.target.files[0] : null),
              }),
          error ? h('div', { className: 'dsp-errorBox' }, error) : null,
          results
            ? h(
                'ul',
                { className: 'dsp-list' },
                ...results.map((item, index) =>
                  h(
                    'li',
                    { key: index, className: item.ok ? null : 'dsp-listItemError' },
                    `${item.name || item.source || ''} ${item.ok ? '已导入' : item.error || '失败'}`,
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dsp-modalFoot' },
            h('button', { type: 'button', className: 'dsp-btn', onClick: onClose }, '关闭'),
            h('button', { type: 'button', className: 'dsp-btn dsp-btnPrimary', disabled: busy, onClick: submit }, busy ? '导入中…' : '导入'),
          ),
        ),
      )
    }

    /* -------------------------------------------------------------- 面板主体 */

    function SkillPanel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [search, setSearch] = useState('')
      const [detail, setDetail] = useState(null)
      const [createOpen, setCreateOpen] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [busyKey, setBusyKey] = useState(null)
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)
      const storedProject = useRef(readProject())

      const showToast = useCallback((text, isError) => {
        setToast({ text, error: !!isError })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 2800)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      const load = useCallback(async (requested, options) => {
        const silent = options && options.silent
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        try {
          const next = await getJson(withParams(`${API}/list`, { project: requested }))
          setData(next)
          storedProject.current = next.projectCwd || ''
          writeProject(next.projectCwd || '')
        } catch (failure) {
          if (silent) showToast(failure.message, true)
          else setError(failure.message)
        } finally {
          setLoading(false)
        }
      }, [showToast])

      useEffect(() => {
        load(storedProject.current)
      }, [load])

      const project = (data && data.projectCwd) || ''
      const hasProject = Boolean(data && data.projectRoot)
      const busy = busyKey !== null

      const run = useCallback(
        async (key, work, message) => {
          setBusyKey(key)
          setPendingDelete(null)
          try {
            await work()
            await load(storedProject.current, { silent: true })
            if (message) showToast(message)
          } catch (failure) {
            showToast(failure.message, true)
          } finally {
            setBusyKey(null)
          }
        },
        [load, showToast],
      )

      const onScope = (skill, scope) => {
        run(
          `scope:${skill.name}`,
          () => postJson(withParams(`${API}/scope`, { project }), { name: skill.name, scope }),
          scope === 'global' ? '已切到全局' : '已切到本项目',
        )
      }

      const onDelete = (skill) => {
        if (pendingDelete !== skill.name) {
          setPendingDelete(skill.name)
          return
        }
        setPendingDelete(null)
        if (skill.stub) {
          run(
            `scope:${skill.name}`,
            () => postJson(withParams(`${API}/scope`, { project }), { name: skill.name, scope: 'global' }),
            '已恢复全局',
          )
          return
        }
        run(
          `delete:${skill.name}`,
          () => postJson(withParams(`${API}/delete`, { project }), { name: skill.name, source: skill.source }),
          '已移到回收目录',
        )
      }

      const openDetail = (skill) => {
        const layer = layerOf(skill) || skill
        setDetail({
          name: skill.name,
          source: layer.source,
          path: layer.path,
          flags: { modelInvocable: !!layer.modelInvocable, userInvocable: !!layer.userInvocable },
        })
      }

      const skills = (data && data.skills) || []
      const workspaces = (data && data.workspaces) || []
      const keyword = search.trim().toLowerCase()
      const matched = useMemo(() => {
        if (!keyword) return skills
        return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(keyword))
      }, [skills, keyword])

      const globalSkills = matched.filter((skill) => skill.scope === 'global' || skill.stub)
      const projectSkills = matched.filter((skill) => skill.scope === 'project' && !skill.stub)
      const diagnostics = (data && data.diagnostics) || []

      const workspaceOptions = useMemo(() => {
        const options = workspaces.map((workspace) => ({ value: workspace.path, label: workspace.title || workspace.path }))
        if (project && !options.some((option) => option.value === project)) options.unshift({ value: project, label: project })
        return options
      }, [workspaces, project])

      return h(
        'div',
        { className: 'dsp-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsp-toolbar' },
          h(
            'select',
            {
              className: 'dsp-select',
              value: project,
              title: '项目',
              onChange: (event) => load(event.target.value),
            },
            workspaceOptions.length
              ? workspaceOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))
              : h('option', { value: '' }, '（无工作区）'),
          ),
          h('input', {
            className: 'dsp-input dsp-grow',
            value: search,
            placeholder: '搜索名称 / 描述 / 路径',
            onChange: (event) => {
              setSearch(event.target.value)
              setPendingDelete(null)
            },
          }),
          h('button', { type: 'button', className: 'dsp-btn', disabled: loading, onClick: () => load(storedProject.current) }, '刷新'),
          h('button', { type: 'button', className: 'dsp-btn', onClick: () => setCreateOpen(true) }, '新建'),
          h('button', { type: 'button', className: 'dsp-btn', onClick: () => setImportOpen(true) }, '导入'),
        ),
        h(
          'div',
          { className: 'dsp-body' },
          error && !data ? h('div', { className: 'dsp-errorBox' }, error) : null,
          !data && loading
            ? h('div', null, h('div', { className: 'dsp-skel' }), h('div', { className: 'dsp-skel' }), h('div', { className: 'dsp-skel' }))
            : null,
          data
            ? h(
                'div',
                null,
                h(
                  Group,
                  {
                    title: '全局技能',
                    count: globalSkills.length,
                    rootPath: data.dshHome ? `${data.dshHome}\\skills` : '',
                    emptyText: keyword ? '没有匹配的全局技能' : '没有全局技能',
                  },
                  globalSkills.map((skill) =>
                    h(SkillRow, {
                      key: 'global:' + skill.name,
                      skill,
                      busy: busyKey === `scope:${skill.name}` || busyKey === `delete:${skill.name}`,
                      pendingDelete: pendingDelete === skill.name,
                      onScope,
                      onOpen: openDetail,
                      onDelete,
                    }),
                  ),
                ),
                h(
                  Group,
                  {
                    title: '本项目技能',
                    count: projectSkills.length,
                    rootPath: hasProject && data.projectRoot ? `${data.projectRoot}\\.dsh\\skills` : '',
                    emptyText: hasProject ? (keyword ? '没有匹配的项目技能' : '没有项目技能') : '没有可用的项目目录',
                  },
                  projectSkills.map((skill) =>
                    h(SkillRow, {
                      key: 'project:' + skill.name,
                      skill,
                      busy: busyKey === `scope:${skill.name}` || busyKey === `delete:${skill.name}`,
                      pendingDelete: pendingDelete === skill.name,
                      onScope,
                      onOpen: openDetail,
                      onDelete,
                    }),
                  ),
                ),
                diagnostics.length
                  ? h(
                      'details',
                      { className: 'dsp-diag' },
                      h('summary', null, `无法读取的条目 ${diagnostics.length}`),
                      h('ul', { className: 'dsp-diagList' }, ...diagnostics.map((item, index) => h('li', { key: index }, `${item.path} — ${item.reason}`))),
                    )
                  : null,
              )
            : null,
        ),
        h(Toast, { toast }),
        detail
          ? h(DetailModal, {
              item: detail,
              project,
              onClose: () => setDetail(null),
              onSaved: () => load(storedProject.current, { silent: true }),
            })
          : null,
        createOpen
          ? h(CreateModal, {
              project,
              hasProject,
              onClose: () => setCreateOpen(false),
              onDone: async (message) => {
                await load(storedProject.current, { silent: true })
                if (message) showToast(message)
              },
            })
          : null,
        importOpen
          ? h(ImportModal, {
              project,
              hasProject,
              onClose: () => setImportOpen(false),
              onDone: () => load(storedProject.current, { silent: true }),
            })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'skills',
                order: 25,
                label: () => '技能',
              },
              SkillPanel,
            ),
          )
        } catch (failure) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-skill-panel] slot registration failed', failure)
        }
      },
    }
  },
})
