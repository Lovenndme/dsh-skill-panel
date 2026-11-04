/**
 * dsh-skill-panel — 浏览器半区（v3，整体重做）。
 *
 * 布局约束（对应验收项）：
 *   - 根节点固定高度，列表在卡片内部滚动；提示、行内确认、详情页、对话框全部绝对定位在面板内部，
 *     不进文档流 → 面板高度与内容无关 → 设置弹窗不会因为任何操作重新居中。
 *   - 行内每一段（名称行 / 两行描述 / 路径行）都是固定高度，徽标不换行 → 行高恒定。
 *   - 弹层不依赖 react-dom portal，也不用 position:fixed（祖先有 transform 时会错位）。
 *   - Esc 按「最上层先关」处理，在 window 捕获阶段拦截，避免连带关闭设置弹窗。
 *   - 忙碌态按技能名记在行上，只禁用该行；弹层自己管自己的忙碌态。
 *   - 选中/开启态统一用「反色实底 + 勾」，不依赖品牌色（深色主题下品牌色是白色）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/api/dsh-skill-panel'
    const PROJECT_KEY = 'dsh-skill-panel.project'
    const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    const MAX_ZIP_BYTES = 32 * 1024 * 1024

    /**
     * 预览用 DSH 聊天界面同一个 Markdown 渲染器：Web 外壳共享模块表里的
     * @deepseek-ai/dsh-client-ui-primitives → MarkdownText（micromark/mdast → React 节点，不走 innerHTML）。
     * 这不是文档化的插件 API：拿不到或渲染出错时退回纯文本，不影响面板其它功能。
     */
    let HostMarkdown = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.MarkdownText !== 'undefined') HostMarkdown = primitives.MarkdownText
    } catch {
      HostMarkdown = null
    }
    // 与聊天界面 markdownLabels() 同结构：代码块工具栏与脚注文案
    const MARKDOWN_LABELS = {
      code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } },
      footnotes: '脚注',
    }

    /* ================================================================ 样式 */

    const STYLE = `
.dskp-root{--dskp-fg:var(--dsw-alias-label-primary,#ececf1);--dskp-fg2:var(--dsw-alias-label-secondary);--dskp-fg3:var(--dsw-alias-state-idle-primary);--dskp-line:var(--dsw-alias-border-l1);--dskp-line2:var(--dsw-alias-border-l2);--dskp-ok:var(--dsw-alias-state-success-primary);--dskp-warn:var(--dsw-alias-state-warn-primary);--dskp-err:var(--dsw-alias-state-error-primary);--dskp-base:var(--dsw-alias-bg-base);--dskp-l1:var(--dsw-alias-bg-layer-1);--dskp-l2:var(--dsw-alias-bg-layer-2);--dskp-raised:linear-gradient(var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-2)),linear-gradient(var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-base);--dskp-inv:var(--dsw-alias-bg-base,#16161a);--dskp-mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,Menlo,monospace;--dskp-h:clamp(360px,calc(100vh - 210px),700px);position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:var(--dskp-h);min-height:0;padding:4px;overflow:hidden;color:var(--dskp-fg);font-size:13px;line-height:1.45;text-align:left}
.dskp-root *,.dskp-root *::before,.dskp-root *::after{box-sizing:border-box}
.dskp-root :where(button,input,select,textarea):where(:not(.dskp-md *)){font-family:inherit;font-size:inherit;line-height:inherit;color:inherit;margin:0;letter-spacing:inherit}
.dskp-root :where(.dskp-ghead-title,.dskp-sheet-name,.dskp-dialog-title){margin:0;font:inherit}
.dskp-root :focus{outline:none}
.dskp-root :focus-visible{outline:2px solid var(--dskp-fg);outline-offset:2px}
.dskp-root .dskp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dskp-root .dskp-icon{display:block;flex:0 0 auto}
.dskp-root .dskp-main{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0}

.dskp-root .dskp-toolbar{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.dskp-root .dskp-field{position:relative;display:flex;align-items:center;height:34px;border-radius:999px;border:1px solid var(--dskp-line2);background:var(--dskp-l1);transition:border-color .12s,box-shadow .12s}
.dskp-root .dskp-field:hover{border-color:var(--dskp-fg3)}
.dskp-root .dskp-field:focus-within{border-color:var(--dskp-fg2);box-shadow:0 0 0 1px var(--dskp-fg2)}
.dskp-root .dskp-field>.dskp-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--dskp-fg3);pointer-events:none}
.dskp-root .dskp-field input{width:100%;height:100%;min-width:0;padding:0 32px 0 34px;border:0;border-radius:999px;background:transparent;font-size:13px}
.dskp-root .dskp-field input:focus-visible{outline:none}
.dskp-root .dskp-field input::placeholder{color:var(--dskp-fg3)}
.dskp-root .dskp-project{flex:0 1 176px;min-width:120px}
.dskp-root .dskp-project.is-open{border-color:var(--dskp-fg2)}
.dskp-root .dskp-picker{display:flex;align-items:center;gap:8px;width:100%;height:100%;min-width:0;padding:0 10px 0 12px;border:0;border-radius:999px;background:transparent;color:var(--dskp-fg);font-size:13px;cursor:pointer;text-align:left}
.dskp-root .dskp-picker:focus-visible{outline:none}
.dskp-root .dskp-picker:disabled{cursor:default;color:var(--dskp-fg3)}
.dskp-root .dskp-picker-icon{color:var(--dskp-fg3)}
.dskp-root .dskp-picker-label{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-picker-caret{color:var(--dskp-fg3);transition:transform .15s}
.dskp-root .dskp-picker-caret.is-open{transform:rotate(180deg)}
.dskp-root .dskp-menu{position:absolute;top:calc(100% + 6px);left:-1px;z-index:30;width:max(100%,300px);max-width:420px;padding:4px;border-radius:12px;border:1px solid var(--dskp-line2);background:var(--dskp-raised);box-shadow:0 14px 40px rgba(0,0,0,.4);animation:dskp-rise .12s ease-out}
.dskp-root .dskp-menu-list{margin:0;padding:0;list-style:none;max-height:288px;overflow-y:auto;overscroll-behavior:contain}
.dskp-root .dskp-option{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-radius:8px;color:var(--dskp-fg2);cursor:pointer}
.dskp-root .dskp-option.is-active{background:var(--dskp-l2);background:color-mix(in srgb,var(--dskp-fg) 9%,transparent);color:var(--dskp-fg)}
.dskp-root .dskp-option.is-selected{color:var(--dskp-fg)}
.dskp-root .dskp-option-text{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.dskp-root .dskp-option-label{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-option.is-selected .dskp-option-label{font-weight:600}
.dskp-root .dskp-path.dskp-option-path{height:auto;font-size:11px;line-height:15px;color:var(--dskp-fg3)}
.dskp-root .dskp-option-check{color:var(--dskp-fg)}
.dskp-root .dskp-search{flex:1 1 200px;min-width:140px}
.dskp-root .dskp-field .dskp-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:24px;height:24px;border-radius:999px}

.dskp-root .dskp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--dskp-line2);background:var(--dskp-l1);color:var(--dskp-fg);font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;flex:0 0 auto;transition:background-color .12s,border-color .12s,opacity .12s}
.dskp-root .dskp-btn:hover:not(:disabled){background:var(--dskp-l2);border-color:var(--dskp-fg3)}
.dskp-root .dskp-btn:disabled{opacity:.45;cursor:not-allowed}
.dskp-root .dskp-btn[aria-busy="true"]:disabled{opacity:.8;cursor:progress}
.dskp-root .dskp-btn--primary{background:var(--dskp-fg);border-color:var(--dskp-fg);color:var(--dskp-inv);font-weight:600}
.dskp-root .dskp-btn--primary:hover:not(:disabled){background:var(--dskp-fg);border-color:var(--dskp-fg);opacity:.86}
.dskp-root .dskp-btn--danger{background:transparent;border-color:var(--dskp-err);color:var(--dskp-err);font-weight:600}
.dskp-root .dskp-btn--danger:hover:not(:disabled){border-color:var(--dskp-err);background:color-mix(in srgb,var(--dskp-err) 16%,transparent)}
.dskp-root .dskp-btn--ghost{background:transparent;border-color:transparent;color:var(--dskp-fg2)}
.dskp-root .dskp-btn--ghost:hover:not(:disabled){background:var(--dskp-l2);border-color:transparent;color:var(--dskp-fg)}
.dskp-root .dskp-btn--sm{height:28px;padding:0 11px;font-size:12px}
.dskp-root .dskp-toolbar .dskp-btn{height:34px}

.dskp-root .dskp-ibtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dskp-fg2);cursor:pointer;flex:0 0 auto;transition:background-color .12s,color .12s,border-color .12s}
.dskp-root .dskp-ibtn:hover:not(:disabled){background:var(--dskp-l2);color:var(--dskp-fg)}
.dskp-root .dskp-ibtn:disabled{opacity:.35;cursor:not-allowed}
.dskp-root .dskp-ibtn--danger:hover:not(:disabled){color:var(--dskp-err);background:color-mix(in srgb,var(--dskp-err) 14%,transparent)}
.dskp-root .dskp-ibtn--boxed{width:34px;height:34px;border-radius:999px;border-color:var(--dskp-line2);background:var(--dskp-l1)}
.dskp-root .dskp-ibtn--boxed:hover:not(:disabled){border-color:var(--dskp-fg3)}
.dskp-root .dskp-ibtn.is-spinning .dskp-icon{animation:dskp-spin .9s linear infinite}

.dskp-root .dskp-spinner{display:inline-block;width:14px;height:14px;flex:0 0 auto;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:dskp-spin .7s linear infinite}
.dskp-root .dskp-spinner--sm{width:11px;height:11px;border-width:1.5px}

.dskp-root .dskp-card{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dskp-line);border-radius:12px;background:linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);overflow:hidden}
.dskp-root .dskp-scroll{position:relative;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--dskp-line2) transparent}
.dskp-root .dskp-progress{position:absolute;left:0;right:0;top:0;height:2px;z-index:5;overflow:hidden;pointer-events:none}
.dskp-root .dskp-progress::before,.dskp-root .dskp-row-busy::before{content:"";position:absolute;top:0;bottom:0;left:0;width:35%;background:var(--dskp-fg2);animation:dskp-indet 1.1s ease-in-out infinite}

.dskp-root .dskp-ghead{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;height:38px;padding:0 14px 0 16px;border-bottom:1px solid var(--dskp-line);background:linear-gradient(var(--dskp-l2),var(--dskp-l2)),linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base)}
.dskp-root .dskp-ghead-icon{color:var(--dskp-fg2)}
.dskp-root .dskp-ghead-title{font-size:12.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.dskp-root .dskp-count{min-width:22px;height:18px;padding:0 7px;border-radius:999px;background:var(--dskp-base);color:var(--dskp-fg2);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
.dskp-root .dskp-path.dskp-ghead-path{flex:1 1 auto;min-width:0;margin-left:10px;text-align:right}

.dskp-root .dskp-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 150px 64px;column-gap:14px;align-items:start;padding:10px 12px 10px 16px;border-bottom:1px solid var(--dskp-line);transition:background-color .12s}
.dskp-root .dskp-row:hover{background-color:color-mix(in srgb,var(--dskp-l2) 55%,transparent)}
.dskp-root .dskp-row.is-stub{box-shadow:inset 3px 0 0 var(--dskp-warn)}
.dskp-root .dskp-info{min-width:0;display:flex;flex-direction:column;gap:2px}
.dskp-root .dskp-line1{display:flex;align-items:center;gap:6px;height:24px;min-width:0;overflow:hidden}
.dskp-root .dskp-name{flex:0 1 auto;min-width:0;padding:0;border:0;background:none;color:var(--dskp-fg);font-family:var(--dskp-mono);font-size:13px;font-weight:600;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;text-align:left}
.dskp-root .dskp-name:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--dskp-fg3)}
.dskp-root .dskp-tags{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto}
.dskp-root .dskp-tag{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:5px;border:1px solid var(--dskp-line2);color:var(--dskp-fg2);font-size:11px;line-height:16px;white-space:nowrap}
.dskp-root .dskp-tag--mono{font-family:var(--dskp-mono);font-size:10.5px}
.dskp-root .dskp-tag--warn{color:var(--dskp-warn);border-color:var(--dskp-warn)}
.dskp-root .dskp-tag--error{color:var(--dskp-err);border-color:var(--dskp-err)}
.dskp-root .dskp-desc{height:34px;font-size:12px;line-height:17px;color:var(--dskp-fg2);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.dskp-root .dskp-desc.is-empty{color:var(--dskp-fg3)}
.dskp-root .dskp-path{height:16px;font-family:var(--dskp-mono);font-size:11px;line-height:16px;color:var(--dskp-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dskp-root .dskp-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.dskp-root .dskp-actions{display:flex;justify-content:flex-end;gap:2px}

.dskp-root .dskp-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;height:28px;padding:2px;border-radius:999px;border:1px solid var(--dskp-line2);background:var(--dskp-base)}
.dskp-root .dskp-seg.is-none{border-style:dashed;border-color:var(--dskp-warn)}
.dskp-root .dskp-seg-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:0;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--dskp-fg2);font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .12s,color .12s}
.dskp-root .dskp-seg-btn:hover:not(:disabled):not(.is-on){background:var(--dskp-l2);color:var(--dskp-fg)}
.dskp-root .dskp-seg-btn.is-on{background:var(--dskp-fg);color:var(--dskp-inv);font-weight:600;cursor:default}
.dskp-root .dskp-seg-btn:disabled{cursor:not-allowed;opacity:.4}
.dskp-root .dskp-seg-btn.is-on:disabled{opacity:.7}
.dskp-root .dskp-seg-btn.is-pending{opacity:1;background:var(--dskp-l2);color:var(--dskp-fg)}
.dskp-root .dskp-seg-btn:focus-visible{outline-offset:1px}
.dskp-root .dskp-seg--inline{display:inline-grid;min-width:200px;height:32px}

.dskp-root .dskp-confirm{position:absolute;inset:0;z-index:2;display:flex;align-items:center;gap:12px;padding:0 12px 0 16px;background:linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);background:linear-gradient(color-mix(in srgb,var(--dskp-err) 12%,transparent),color-mix(in srgb,var(--dskp-err) 12%,transparent)),linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);box-shadow:inset 3px 0 0 var(--dskp-err);animation:dskp-fade .12s ease-out}
.dskp-root .dskp-confirm.is-restore{background:linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);background:linear-gradient(color-mix(in srgb,var(--dskp-warn) 12%,transparent),color-mix(in srgb,var(--dskp-warn) 12%,transparent)),linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);box-shadow:inset 3px 0 0 var(--dskp-warn)}
.dskp-root .dskp-confirm-icon{color:var(--dskp-err)}
.dskp-root .dskp-confirm.is-restore .dskp-confirm-icon{color:var(--dskp-warn)}
.dskp-root .dskp-confirm-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.dskp-root .dskp-confirm-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-confirm-title code{font-family:var(--dskp-mono);font-size:12.5px}
.dskp-root .dskp-confirm-actions{display:flex;gap:8px;flex:0 0 auto}

.dskp-root .dskp-row-flash{position:absolute;inset:0;pointer-events:none;background:color-mix(in srgb,var(--dskp-ok) 14%,transparent);box-shadow:inset 3px 0 0 var(--dskp-ok);animation:dskp-flash 1.8s ease-out forwards}
.dskp-root .dskp-row-busy{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;pointer-events:none}

.dskp-root .dskp-empty{display:flex;align-items:center;justify-content:center;gap:8px;height:76px;border-bottom:1px solid var(--dskp-line);color:var(--dskp-fg3);font-size:12.5px}
.dskp-root .dskp-skel{display:block;border-radius:4px;background:linear-gradient(90deg,var(--dskp-l2) 0%,var(--dskp-l1) 50%,var(--dskp-l2) 100%);background-size:200% 100%;animation:dskp-shimmer 1.4s linear infinite}
.dskp-root .dskp-row--skel .dskp-path{direction:ltr}
.dskp-root .dskp-row--skel .dskp-line1{height:24px}
.dskp-root .dskp-row--skel .dskp-desc{display:block}
.dskp-root .dskp-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;min-height:220px;padding:24px;text-align:center}
.dskp-root .dskp-state-icon{color:var(--dskp-err)}
.dskp-root .dskp-state-msg{max-width:460px;color:var(--dskp-err);font-size:13px;overflow-wrap:anywhere}

.dskp-root .dskp-diag-toggle{display:flex;align-items:center;gap:8px;width:100%;height:38px;padding:0 16px;border:0;background:transparent;color:var(--dskp-warn);font-size:12px;text-align:left;cursor:pointer}
.dskp-root .dskp-diag-toggle:hover{background:color-mix(in srgb,var(--dskp-l2) 55%,transparent)}
.dskp-root .dskp-diag-caret{margin-left:auto;transition:transform .15s}
.dskp-root .dskp-diag-caret.is-open{transform:rotate(180deg)}
.dskp-root .dskp-diag-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:2px 16px 14px 39px;list-style:none}
.dskp-root .dskp-diag-item{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--dskp-fg2);overflow-wrap:anywhere}
.dskp-root .dskp-diag-item code{font-family:var(--dskp-mono);font-size:11px;color:var(--dskp-fg)}

.dskp-root .dskp-toasts{position:absolute;left:12px;bottom:12px;z-index:40;display:flex;flex-direction:column;gap:6px;width:min(440px,calc(100% - 24px));pointer-events:none}
.dskp-root .dskp-toast{display:flex;align-items:flex-start;gap:8px;padding:9px 6px 9px 12px;border-radius:10px;border:1px solid var(--dskp-line2);background:var(--dskp-raised);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:12.5px;line-height:1.45;pointer-events:auto;animation:dskp-rise .16s ease-out}
.dskp-root .dskp-toast-icon{margin-top:1px}
.dskp-root .dskp-toast--success .dskp-toast-icon{color:var(--dskp-ok)}
.dskp-root .dskp-toast--error{border-color:var(--dskp-err)}
.dskp-root .dskp-toast--error .dskp-toast-icon{color:var(--dskp-err)}
.dskp-root .dskp-toast-text{flex:1 1 auto;min-width:0;padding-top:1px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
.dskp-root .dskp-ibtn.dskp-toast-close{width:22px;height:22px;border-radius:6px}

.dskp-root .dskp-sheet{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;border:1px solid var(--dskp-line2);border-radius:12px;background:linear-gradient(var(--dskp-l1),var(--dskp-l1)),var(--dskp-base);overflow:hidden;animation:dskp-rise .16s ease-out}
.dskp-root .dskp-sheet:focus-visible{outline:none}
.dskp-root .dskp-sheet-head{display:flex;align-items:center;gap:10px;height:50px;padding:0 10px 0 8px;border-bottom:1px solid var(--dskp-line);flex:0 0 auto}
.dskp-root .dskp-sheet-title{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0}
.dskp-root .dskp-sheet-name{min-width:0;font-family:var(--dskp-mono);font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-sheet-meta{display:flex;align-items:center;gap:12px;height:30px;padding:0 16px;border-bottom:1px solid var(--dskp-line);flex:0 0 auto;font-size:11px;color:var(--dskp-fg3)}
.dskp-root .dskp-sheet-meta .dskp-path{flex:1 1 auto;min-width:0}
.dskp-root .dskp-sheet-size{flex:0 0 auto;font-variant-numeric:tabular-nums}
.dskp-root .dskp-sheet-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;min-height:52px;padding:10px 16px;flex:0 0 auto}
.dskp-root .dskp-flagctl{display:inline-flex;align-items:center;gap:10px;white-space:nowrap}
.dskp-root .dskp-flagctl-label{font-size:12.5px;color:var(--dskp-fg)}
.dskp-root .dskp-switch{display:inline-flex;align-items:center;gap:8px;padding:2px;border:0;border-radius:999px;background:transparent;cursor:pointer}
.dskp-root .dskp-switch:disabled{cursor:not-allowed;opacity:.5}
.dskp-root .dskp-switch-track{position:relative;width:38px;height:22px;flex:0 0 auto;border-radius:999px;border:1px solid var(--dskp-line2);background:var(--dskp-base);transition:background-color .15s,border-color .15s}
.dskp-root .dskp-switch-knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dskp-fg3);transition:transform .15s,background-color .15s}
.dskp-root .dskp-switch.is-on .dskp-switch-track{background:var(--dskp-ok);border-color:var(--dskp-ok)}
.dskp-root .dskp-switch.is-on .dskp-switch-knob{transform:translateX(16px);background:var(--dskp-inv)}
.dskp-root .dskp-switch-text{display:inline-flex;align-items:center;min-width:14px;font-size:12px;font-weight:600;color:var(--dskp-fg3)}
.dskp-root .dskp-switch.is-on .dskp-switch-text{color:var(--dskp-ok)}
.dskp-root .dskp-switch.is-partial .dskp-switch-track{border-color:var(--dskp-warn)}
.dskp-root .dskp-switch.is-partial .dskp-switch-text{color:var(--dskp-warn)}
.dskp-root .dskp-bar-end{display:flex;align-items:center;gap:10px;margin-left:auto;flex:0 0 auto}
.dskp-root .dskp-seg--bar{min-width:128px;height:30px}
.dskp-root .dskp-layers{display:inline-flex;gap:2px;height:30px;padding:2px;border-radius:999px;border:1px solid var(--dskp-line2);background:var(--dskp-base);flex:0 0 auto}
.dskp-root .dskp-layer{display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--dskp-fg2);font-size:12px;white-space:nowrap;cursor:pointer}
.dskp-root .dskp-layer:hover:not(:disabled):not(.is-on){background:var(--dskp-l2);color:var(--dskp-fg)}
.dskp-root .dskp-layer.is-on{background:var(--dskp-fg);color:var(--dskp-inv);font-weight:600;cursor:default}
.dskp-root .dskp-layer:disabled{opacity:.4;cursor:not-allowed}
.dskp-root .dskp-layer-src{font-family:var(--dskp-mono);font-size:11px;opacity:.85}
.dskp-root .dskp-sheet-alert{padding:0 16px 10px;flex:0 0 auto}
.dskp-root .dskp-editor-wrap{display:flex;flex:1 1 auto;min-height:0;padding:0 16px}
.dskp-root .dskp-editor{flex:1 1 auto;width:100%;min-height:0;resize:none;padding:12px 14px;border-radius:10px;border:1px solid var(--dskp-line2);background:var(--dskp-base);color:var(--dskp-fg);font-family:var(--dskp-mono);font-size:12.5px;line-height:1.6;tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
.dskp-root .dskp-editor:focus-visible{outline:none;border-color:var(--dskp-fg2);box-shadow:0 0 0 1px var(--dskp-fg2)}
.dskp-root .dskp-editor[readonly]{opacity:.7}
.dskp-root .dskp-preview-box{flex:1 1 auto;width:100%;min-height:0;overflow:auto;padding:16px 20px 20px;border-radius:10px;border:1px solid var(--dskp-line2);background:var(--dskp-base);color:var(--dskp-fg);overscroll-behavior:contain}
.dskp-root .dskp-fm{margin:0 0 20px;padding:2px 0 18px;border-bottom:1px solid var(--dskp-line)}
.dskp-root .dskp-fm-caption{margin:0 0 6px;font-size:11px;letter-spacing:.04em;color:var(--dskp-fg3)}
.dskp-root .dskp-fm-desc{margin:0;padding-left:12px;border-left:2px solid var(--dskp-line2);font-size:13px;line-height:1.7;color:var(--dskp-fg2);white-space:pre-wrap;overflow-wrap:anywhere}
.dskp-root .dskp-fm-extra{display:flex;flex-direction:column;gap:4px;margin:14px 0 0}
.dskp-root .dskp-fm-row{display:flex;gap:12px;min-width:0;font-size:12px;line-height:1.6}
.dskp-root .dskp-fm-row dt{flex:0 0 76px;color:var(--dskp-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-fm-row dd{flex:1 1 auto;min-width:0;margin:0;color:var(--dskp-fg2);white-space:pre-wrap;overflow-wrap:anywhere}
.dskp-root .dskp-md{min-width:0;font-size:13.5px;line-height:1.65;color:var(--dskp-fg);overflow-wrap:anywhere}
.dskp-root .dskp-md-plain{margin:0;font-family:var(--dskp-mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dskp-fg)}
.dskp-root .dskp-preview-empty{padding:24px 0;text-align:center;font-size:12.5px;color:var(--dskp-fg3)}
.dskp-root .dskp-editor--state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dskp-fg3);font-family:inherit;font-size:12.5px;text-align:center}
.dskp-root .dskp-editor--state.is-error{color:var(--dskp-err)}
.dskp-root .dskp-sheet-foot{display:flex;align-items:center;gap:8px;height:58px;padding:0 16px;flex:0 0 auto}
.dskp-root .dskp-foot-status{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;font-size:12px;color:var(--dskp-fg3);white-space:nowrap;overflow:hidden}
.dskp-root .dskp-foot-status.is-dirty{color:var(--dskp-warn)}
.dskp-root .dskp-foot-status.is-saved{color:var(--dskp-ok)}
.dskp-root .dskp-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:currentColor}

.dskp-root .dskp-scrim{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-start;justify-content:center;padding:44px 16px 16px;background:rgba(0,0,0,.5);background:color-mix(in srgb,var(--dskp-base) 72%,transparent);animation:dskp-fade .12s ease-out}
.dskp-root .dskp-dialog{display:flex;flex-direction:column;width:min(500px,100%);max-height:100%;border:1px solid var(--dskp-line2);border-radius:14px;background:var(--dskp-raised);box-shadow:0 20px 50px rgba(0,0,0,.45);overflow:hidden;animation:dskp-rise .16s ease-out}
.dskp-root .dskp-dialog:focus-visible{outline:none}
.dskp-root .dskp-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px;height:50px;padding:0 10px 0 20px;border-bottom:1px solid var(--dskp-line);flex:0 0 auto}
.dskp-root .dskp-dialog-title{font-size:14px;font-weight:600}
.dskp-root .dskp-dialog-body{display:grid;grid-template-columns:52px minmax(0,1fr);align-items:start;gap:14px 12px;padding:18px 20px;overflow-y:auto;min-height:0}
.dskp-root .dskp-dlabel{padding-top:7px;font-size:12.5px;color:var(--dskp-fg2);white-space:nowrap}
.dskp-root .dskp-dfield{min-width:0}
.dskp-root .dskp-span{grid-column:1 / -1;min-width:0}
.dskp-root .dskp-input{display:block;width:100%;height:34px;padding:0 12px;border-radius:9px;border:1px solid var(--dskp-line2);background:var(--dskp-base);color:var(--dskp-fg);font-size:13px;transition:border-color .12s,box-shadow .12s}
.dskp-root .dskp-input::placeholder{color:var(--dskp-fg3)}
.dskp-root .dskp-input:hover:not(:disabled){border-color:var(--dskp-fg3)}
.dskp-root .dskp-input:focus-visible{outline:none;border-color:var(--dskp-fg2);box-shadow:0 0 0 1px var(--dskp-fg2)}
.dskp-root .dskp-input.is-mono{font-family:var(--dskp-mono);font-size:12.5px}
.dskp-root .dskp-input.is-invalid{border-color:var(--dskp-err);box-shadow:0 0 0 1px var(--dskp-err)}
.dskp-root textarea.dskp-input{height:76px;padding:8px 12px;resize:none;line-height:1.5}
.dskp-root .dskp-field-error{margin-top:6px;font-size:11.5px;color:var(--dskp-err)}
.dskp-root .dskp-path.dskp-target{height:auto;padding-top:8px;font-size:11px}
.dskp-root .dskp-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid var(--dskp-line);flex:0 0 auto}
.dskp-root .dskp-alert{display:flex;align-items:flex-start;gap:8px;padding:8px 6px 8px 10px;border-radius:9px;border:1px solid var(--dskp-err);background:color-mix(in srgb,var(--dskp-err) 10%,transparent);color:var(--dskp-err);font-size:12.5px}
.dskp-root .dskp-alert>.dskp-icon{margin-top:2px}
.dskp-root .dskp-alert-text{flex:1 1 auto;min-width:0;max-height:5.6em;overflow:auto;overflow-wrap:anywhere;padding-top:1px}
.dskp-root .dskp-alert .dskp-ibtn{width:22px;height:22px;color:inherit}
.dskp-root .dskp-drop{display:flex;align-items:center;gap:12px;width:100%;min-height:62px;padding:10px 14px;border-radius:10px;border:1.5px dashed var(--dskp-line2);background:var(--dskp-base);color:var(--dskp-fg2);text-align:left;cursor:pointer;transition:border-color .12s,color .12s}
.dskp-root .dskp-drop:hover:not(:disabled),.dskp-root .dskp-drop.is-over{border-color:var(--dskp-fg2);color:var(--dskp-fg)}
.dskp-root .dskp-drop.has-file{border-style:solid;color:var(--dskp-fg)}
.dskp-root .dskp-drop:disabled{opacity:.5;cursor:not-allowed}
.dskp-root .dskp-drop-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dskp-root .dskp-drop-name{font-family:var(--dskp-mono);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dskp-root .dskp-drop-meta{font-size:11px;color:var(--dskp-fg3)}
.dskp-root .dskp-results{display:flex;flex-direction:column;gap:2px;margin:0;padding:6px 0;max-height:150px;overflow-y:auto;list-style:none;border-radius:10px;border:1px solid var(--dskp-line);background:var(--dskp-base)}
.dskp-root .dskp-result{display:flex;align-items:flex-start;gap:8px;padding:4px 12px;font-size:12px}
.dskp-root .dskp-result>.dskp-icon{margin-top:2px}
.dskp-root .dskp-result.is-ok>.dskp-icon{color:var(--dskp-ok)}
.dskp-root .dskp-result.is-fail>.dskp-icon{color:var(--dskp-err)}
.dskp-root .dskp-result-name{font-family:var(--dskp-mono);font-weight:600;white-space:nowrap}
.dskp-root .dskp-result-meta{color:var(--dskp-fg3)}
.dskp-root .dskp-result-err{color:var(--dskp-err);overflow-wrap:anywhere;min-width:0}

@keyframes dskp-spin{to{transform:rotate(360deg)}}
@keyframes dskp-indet{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@keyframes dskp-fade{from{opacity:0}to{opacity:1}}
@keyframes dskp-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dskp-flash{0%,40%{opacity:1}100%{opacity:0}}
@keyframes dskp-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.dskp-root .dskp-sheet,.dskp-root .dskp-dialog,.dskp-root .dskp-scrim,.dskp-root .dskp-toast,.dskp-root .dskp-confirm{animation:none}}
`

    /* ================================================================ 工具 */

    const cx = (...parts) => parts.filter(Boolean).join(' ')
    /** 透传 children 时展开成可变参数，避免把数组当成一个无 key 的列表。 */
    const kids = (children) => (Array.isArray(children) ? children : [children])

    let uidSeed = 0
    function useUid(prefix) {
      const ref = useRef('')
      if (!ref.current) {
        uidSeed += 1
        ref.current = `dskp-${prefix}-${uidSeed}`
      }
      return ref.current
    }

    function withParams(base, params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text ? `${base}?${text}` : base
    }

    const api = (endpoint, params) => withParams(`${API}/${endpoint}`, params)

    async function request(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (failure) {
        throw new Error(`网络请求失败：${(failure && failure.message) || failure}`)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload && payload.ok === false) {
        const errors = Array.isArray(payload.errors) && payload.errors.length ? payload.errors.join('；') : `请求失败（HTTP ${response.status}）`
        throw new Error(errors)
      }
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`)
      if (!payload) throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
      return payload
    }

    const getJson = (url) => request(url, { headers: { accept: 'application/json' }, cache: 'no-store' })

    const postJson = (url, body) =>
      request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })

    const postBytes = (url, bytes) =>
      request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
        body: bytes,
      })

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
        /* 无痕模式或存储被禁用：忽略 */
      }
    }

    const SOURCES = {
      'user-dsh': '~/.dsh',
      'user-agents': '~/.agents',
      'project-dsh': '.dsh',
      'project-agents': '.agents',
    }

    const sourceLabel = (source) => SOURCES[source] || source || ''
    const scopeLabel = (scope) => (scope === 'global' ? '全局' : '本项目')
    const isAgentsSource = (source) => source === 'user-agents' || source === 'project-agents'

    function layersOf(skill) {
      return skill ? [skill, ...(skill.shadowed || [])] : []
    }

    function globalLayerOf(skill) {
      if (!skill) return null
      if (skill.scope === 'global' && !skill.stub) return skill
      return (skill.shadowed || []).find((layer) => layer.scope === 'global') || null
    }

    function matchesSkill(skill, keyword) {
      if (!keyword) return true
      const parts = [skill.name, skill.description, skill.path]
      for (const layer of skill.shadowed || []) parts.push(layer.description, layer.path)
      return parts.join('\n').toLowerCase().includes(keyword)
    }

    function zipSkillName(fileName) {
      return String(fileName || '')
        .replace(/\.zip$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    }

    function baseName(value) {
      const parts = String(value || '').split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : String(value || '')
    }

    function joinPath(root, ...segments) {
      const sep = String(root).includes('\\') ? '\\' : '/'
      return [String(root).replace(/[\\/]+$/, ''), ...segments].join(sep)
    }

    function formatBytes(size) {
      const value = Number(size) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    const isAbsolutePath = (value) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
      return String(value).replace(/["\\]/g, '\\$&')
    }

    function focusQuietly(element) {
      if (!element || typeof element.focus !== 'function') return
      try {
        element.focus({ preventScroll: true })
      } catch {
        element.focus()
      }
    }

    /** 只在面板自己的滚动容器里滚，不牵动设置弹窗。 */
    function revealRow(scroller, row) {
      const outer = scroller.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      const header = 42
      let delta = 0
      if (rect.top < outer.top + header) delta = rect.top - outer.top - header
      else if (rect.bottom > outer.bottom) delta = rect.bottom - outer.bottom + 4
      if (!delta) return
      if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top: delta, behavior: 'smooth' })
      else scroller.scrollTop += delta
    }

    /* ---------------------------------------------- Esc：最上层先处理 */

    const escapeLayers = []

    function useEscapeLayer(active, handler) {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        if (!active) return undefined
        const layer = (event) => ref.current(event)
        escapeLayers.push(layer)
        return () => {
          const index = escapeLayers.lastIndexOf(layer)
          if (index >= 0) escapeLayers.splice(index, 1)
        }
      }, [active])
    }

    /* ================================================================ 图标 */

    const ICONS = {
      search: ['M16.5 10.5a6 6 0 1 1-12 0a6 6 0 1 1 12 0', 'M20 20l-5.2-5.2'],
      refresh: ['M19.5 12a7.5 7.5 0 0 1-13.4 4.6', 'M4.5 12a7.5 7.5 0 0 1 13.4-4.6', 'M18.5 3.5v4.2h-4.2', 'M5.5 20.5v-4.2h4.2'],
      plus: ['M12 5v14', 'M5 12h14'],
      import: ['M12 4v10', 'M7.5 9.5L12 14l4.5-4.5', 'M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3'],
      edit: ['M14 6l4 4', 'M4.5 19.5l1-4.5L15.6 4.9a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7L9 18.5z'],
      trash: ['M4.5 7h15', 'M10 11v6', 'M14 11v6', 'M6.5 7l.9 11.6a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7', 'M9.5 7V4.5h5V7'],
      globe: ['M20.5 12a8.5 8.5 0 1 1-17 0a8.5 8.5 0 1 1 17 0', 'M4 9h16', 'M4 15h16', 'M12 3.5c2.3 2.4 3.3 5.2 3.3 8.5s-1 6.1-3.3 8.5c-2.3-2.4-3.3-5.2-3.3-8.5s1-6.1 3.3-8.5z'],
      folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
      back: ['M14.5 5.5L8 12l6.5 6.5'],
      down: ['M6.5 9.5L12 15l5.5-5.5'],
      alert: ['M12 4l8.7 15.2H3.3z', 'M12 10v4.2', 'M12 17.1v.1'],
      undo: ['M9 14.5L4.5 10L9 5.5', 'M4.5 10H15a4.5 4.5 0 0 1 0 9h-3'],
      file: ['M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z', 'M14 3.5V8h4.5'],
      layers: ['M12 4.5l8 4-8 4-8-4z', 'M4 12.5l8 4 8-4', 'M4 16.5l8 4 8-4'],
    }

    function Icon({ name, size, className }) {
      const pixels = size || 16
      return h(
        'svg',
        {
          className: cx('dskp-icon', className),
          width: pixels,
          height: pixels,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (ICONS[name] || []).map((d, index) => h('path', { key: index, d })),
      )
    }

    /* ============================================================ 基础控件 */

    function Spinner({ small }) {
      return h('span', { className: cx('dskp-spinner', small && 'dskp-spinner--sm'), 'aria-hidden': 'true' })
    }

    const Button = React.forwardRef(function Button(props, ref) {
      const { variant, size, icon, busy, children, className, ...rest } = props
      const small = size === 'sm'
      return h(
        'button',
        {
          type: 'button',
          ...rest,
          ref,
          className: cx('dskp-btn', variant && `dskp-btn--${variant}`, small && 'dskp-btn--sm', className),
          'aria-busy': busy ? 'true' : undefined,
        },
        busy ? h(Spinner, { small }) : icon ? h(Icon, { name: icon, size: small ? 14 : 16 }) : null,
        children === undefined || children === null ? null : h('span', null, children),
      )
    })

    const IconButton = React.forwardRef(function IconButton(props, ref) {
      const { icon, label, tone, busy, size, className, ...rest } = props
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          ...rest,
          ref,
          className: cx('dskp-ibtn', tone && `dskp-ibtn--${tone}`, className),
          'aria-busy': busy ? 'true' : undefined,
        },
        busy ? h(Spinner, { small: true }) : h(Icon, { name: icon, size: size || 16 }),
      )
    })

    /** 二选一 / 多选一：每段都是可 Tab 的按钮，选中段 aria-pressed=true，反色实底 + 勾。 */
    function Segmented({ label, options, value, pending, disabled, onSelect, className }) {
      return h(
        'div',
        { className: cx('dskp-seg', value == null && 'is-none', className), role: 'group', 'aria-label': label },
        options.map((option) => {
          const on = option.value === value
          const isPending = pending === option.value
          return h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: cx('dskp-seg-btn', on && 'is-on', isPending && 'is-pending'),
              'aria-pressed': on ? 'true' : 'false',
              disabled: !!(disabled || option.disabled),
              title: on ? undefined : option.title,
              onClick: () => {
                if (!on) onSelect(option.value)
              },
            },
            isPending ? h(Spinner, { small: true }) : on ? h(Icon, { name: 'check', size: 13 }) : null,
            h('span', null, option.label),
          )
        }),
      )
    }

    /** partial：两项只开了一项（手写或导入的文件），显示「部分」，点一下统一成全开。 */
    function Switch({ label, checked, partial, busy, disabled, title, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': partial ? `${label}（部分开启）` : label,
          'aria-busy': busy ? 'true' : undefined,
          title,
          disabled: !!(disabled || busy),
          className: cx('dskp-switch', checked && 'is-on', partial && 'is-partial'),
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dskp-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'dskp-switch-knob' })),
        h('span', { className: 'dskp-switch-text', 'aria-hidden': 'true' }, busy ? h(Spinner, { small: true }) : checked ? '开' : partial ? '部分' : '关'),
      )
    }

    function FlagControl(props) {
      return h('div', { className: 'dskp-flagctl' }, h('span', { className: 'dskp-flagctl-label', 'aria-hidden': 'true' }, props.label), h(Switch, props))
    }

    /** 长路径：省略号在左侧，保住末尾的技能目录名；完整路径放 title。 */
    function PathText({ path, className }) {
      const text = path || ''
      return h('div', { className: cx('dskp-path', className), title: text || undefined }, `\u200E${text}\u200E`)
    }

    function Tag({ tone, mono, title, children }) {
      return h('span', { className: cx('dskp-tag', tone && `dskp-tag--${tone}`, mono && 'dskp-tag--mono'), title }, ...kids(children))
    }

    /** 宿主向 DSH 注册表核对的结果：只有「没被 DSH 采用」时才出标签。 */
    function dshProblem(dsh) {
      if (!dsh || dsh.state === 'loaded') return null
      if (dsh.state === 'missing') return { text: 'DSH 未加载', title: 'DSH 没有加载这份技能：frontmatter 无法被 DSH 解析' }
      return { text: '未生效', title: `DSH 实际生效的是 ${sourceLabel(dsh.source)} 的同名技能${dsh.path ? `\n${dsh.path}` : ''}` }
    }

    function invocationTitle(model, user) {
      return `模型可调用：${model ? '开' : '关'}　/命令可调用：${user ? '开' : '关'}`
    }

    /** 启用状态只在异常时出标签：全开是常态，不显示。 */
    function invocationState(skill) {
      const model = !!skill.modelInvocable
      const user = !!skill.userInvocable
      if (model && user) return null
      const title = invocationTitle(model, user)
      if (!model && !user) return { text: '已停用', title }
      return { text: '部分启用', title }
    }

    function Alert({ text, onClose }) {
      if (!text) return null
      return h(
        'div',
        { className: 'dskp-alert', role: 'alert' },
        h(Icon, { name: 'alert', size: 15 }),
        h('div', { className: 'dskp-alert-text' }, text),
        onClose ? h(IconButton, { icon: 'x', label: '关闭', size: 13, onClick: onClose }) : null,
      )
    }

    /**
     * 项目选择器：替代原生 <select>（弹出列表由系统绘制、无法美化）。
     * 交互照 WAI-ARIA APG「select-only combobox」：焦点留在按钮上，
     * ↑↓ / Home / End 移动，Enter / 空格选中，Esc 或点外面关闭。
     */
    function ProjectPicker({ value, options, onChange }) {
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(0)
      const wrapRef = useRef(null)
      const listRef = useRef(null)
      const listId = useUid('projects')
      const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
      const current = options.find((option) => option.value === value)
      const disabled = !options.length

      const openAt = (index) => {
        if (disabled) return
        setActive(index === undefined ? selectedIndex : index)
        setOpen(true)
      }
      const choose = (index) => {
        const option = options[index]
        setOpen(false)
        if (option && option.value !== value) onChange(option.value)
      }

      useEscapeLayer(open, () => {
        setOpen(false)
        return true
      })

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        return () => document.removeEventListener('mousedown', onPointerDown, true)
      }, [open])

      // 键盘移动时让当前项留在列表可见区（只滚列表自己）
      useEffect(() => {
        const list = listRef.current
        const item = open && list ? list.children[active] : null
        if (!item || typeof item.offsetTop !== 'number') return
        if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop
        else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight
      }, [open, active])

      const onKeyDown = (event) => {
        const last = options.length - 1
        if (!open) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openAt()
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            openAt(event.key === 'Home' ? 0 : last)
          }
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((index) => Math.min(last, index + 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((index) => Math.max(0, index - 1))
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          setActive(event.key === 'Home' ? 0 : last)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          choose(active)
        } else if (event.key === 'Tab') {
          setOpen(false)
        }
      }

      return h(
        'div',
        { ref: wrapRef, className: cx('dskp-field', 'dskp-project', open && 'is-open') },
        h(
          'button',
          {
            type: 'button',
            role: 'combobox',
            className: 'dskp-picker',
            'aria-label': '项目',
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': listId,
            'aria-activedescendant': open ? `${listId}-${active}` : undefined,
            title: value || undefined,
            disabled,
            onClick: () => (open ? setOpen(false) : openAt()),
            onKeyDown,
          },
          h(Icon, { name: 'folder', size: 15, className: 'dskp-picker-icon' }),
          h('span', { className: 'dskp-picker-label' }, current ? current.label : '无项目'),
          h(Icon, { name: 'down', size: 14, className: cx('dskp-picker-caret', open && 'is-open') }),
        ),
        open
          ? h(
              'div',
              { className: 'dskp-menu' },
              h(
                'ul',
                { id: listId, ref: listRef, role: 'listbox', 'aria-label': '项目', className: 'dskp-menu-list' },
                options.map((option, index) => {
                  const selected = option.value === value
                  return h(
                    'li',
                    {
                      key: option.value,
                      id: `${listId}-${index}`,
                      role: 'option',
                      'aria-selected': selected ? 'true' : 'false',
                      className: cx('dskp-option', index === active && 'is-active', selected && 'is-selected'),
                      onMouseDown: (event) => event.preventDefault(),
                      onMouseEnter: () => setActive(index),
                      onClick: () => choose(index),
                    },
                    h(
                      'span',
                      { className: 'dskp-option-text' },
                      h('span', { className: 'dskp-option-label' }, option.label),
                      h(PathText, { path: option.value, className: 'dskp-option-path' }),
                    ),
                    selected ? h(Icon, { name: 'check', size: 14, className: 'dskp-option-check' }) : null,
                  )
                }),
              ),
            )
          : null,
      )
    }

    /* =============================================================== 列表 */

    function ConfirmStrip({ skill, onCancel, onConfirm }) {
      const stub = !!skill.stub
      const cancelRef = useRef(null)
      useEffect(() => {
        focusQuietly(cancelRef.current)
      }, [])
      useEscapeLayer(true, () => {
        onCancel(true)
        return true
      })
      const target = skill.kind === 'dir' ? skill.dir : skill.path
      return h(
        'div',
        {
          className: cx('dskp-confirm', stub && 'is-restore'),
          role: 'group',
          'aria-label': stub ? `确认删除占位 ${skill.name}` : `确认删除 ${skill.name}`,
          tabIndex: -1,
          onBlur: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) onCancel(false)
          },
        },
        h(Icon, { name: stub ? 'undo' : 'trash', size: 18, className: 'dskp-confirm-icon' }),
        h(
          'div',
          { className: 'dskp-confirm-text' },
          h('div', { className: 'dskp-confirm-title' }, stub ? '删除占位 ' : '删除 ', h('code', null, skill.name), ' ？'),
          h(PathText, { path: target }),
        ),
        h(
          'div',
          { className: 'dskp-confirm-actions' },
          h(Button, { ref: cancelRef, size: 'sm', onClick: () => onCancel(true) }, '取消'),
          h(
            Button,
            { size: 'sm', variant: stub ? 'primary' : 'danger', icon: stub ? 'undo' : 'trash', onClick: () => onConfirm(skill) },
            stub ? '恢复全局' : '移到回收目录',
          ),
        ),
      )
    }

    function SkillRow({ skill, hasProject, busy, confirming, flashToken, onScope, onOpen, onAskDelete, onCancelDelete, onConfirmDelete }) {
      const stub = !!skill.stub
      const base = stub ? globalLayerOf(skill) || skill : skill
      const shadowed = skill.shadowed || []
      const description = base.description || ''
      const deleteRef = useRef(null)
      const restoreFocus = useRef(false)

      // 确认条用「取消 / Esc」关掉后，焦点回到本行的删除按钮
      useEffect(() => {
        if (!confirming && restoreFocus.current) {
          restoreFocus.current = false
          if (!busy) focusQuietly(deleteRef.current)
        }
      }, [confirming, busy])

      const cancelConfirm = (restore) => {
        restoreFocus.current = !!restore
        onCancelDelete()
      }

      const shadowTitle = shadowed
        .map((layer) => `${sourceLabel(layer.source)}${layer.modelInvocable || layer.userInvocable ? '' : '（已停用）'}  ${layer.path}`)
        .join('\n')
      const shadowText = shadowed.length === 1 ? `覆盖 ${sourceLabel(shadowed[0].source)}` : `覆盖 ${shadowed.length} 份`
      // DSH 没采用这份时，开关状态没有意义；占位行已经有「本项目已停用」——两种情况都不再叠加调用状态标签
      const dshIssue = dshProblem(skill.dsh)
      const invocation = stub || dshIssue ? null : invocationState(skill)

      const scopeOptions = [
        { value: 'global', label: '全局', title: stub ? '恢复全局' : '切到全局' },
        { value: 'project', label: '本项目', disabled: !hasProject, title: hasProject ? '切到本项目' : '没有项目目录' },
      ]

      return h(
        'div',
        {
          className: cx('dskp-row', stub && 'is-stub'),
          'data-skill': skill.name,
          'aria-busy': busy ? 'true' : undefined,
        },
        flashToken ? h('span', { key: `flash-${flashToken}`, className: 'dskp-row-flash', 'aria-hidden': 'true' }) : null,
        h(
          'div',
          { className: 'dskp-info' },
          h(
            'div',
            { className: 'dskp-line1' },
            h('button', { type: 'button', tabIndex: -1, className: 'dskp-name', title: skill.name, onClick: () => onOpen(skill) }, skill.name),
            h(
              'span',
              { className: 'dskp-tags' },
              dshIssue ? h(Tag, { tone: 'error', title: dshIssue.title }, dshIssue.text) : null,
              stub ? h(Tag, { tone: 'warn', title: skill.path }, '本项目已停用') : null,
              invocation ? h(Tag, { tone: 'warn', title: invocation.title }, invocation.text) : null,
              isAgentsSource(base.source) ? h(Tag, { mono: true, title: base.path }, sourceLabel(base.source)) : null,
              !stub && shadowed.length ? h(Tag, { title: shadowTitle }, h(Icon, { name: 'layers', size: 11 }), shadowText) : null,
            ),
          ),
          h('div', { className: cx('dskp-desc', !description && 'is-empty'), title: description || undefined }, description || '无描述'),
          h(PathText, { path: base.path }),
        ),
        h(
          'div',
          { className: 'dskp-side' },
          h(Segmented, {
            label: `${skill.name} 作用域`,
            options: scopeOptions,
            value: stub ? null : skill.scope,
            pending: busy && busy.action === 'scope' ? busy.target : null,
            disabled: !!busy,
            onSelect: (next) => onScope(skill, next),
          }),
        ),
        h(
          'div',
          { className: 'dskp-actions' },
          h(IconButton, { icon: 'edit', label: `查看 / 编辑 ${skill.name}`, disabled: !!busy, onClick: () => onOpen(skill) }),
          h(IconButton, {
            ref: deleteRef,
            icon: 'trash',
            tone: 'danger',
            label: stub ? `删除占位并恢复全局 ${skill.name}` : `删除 ${skill.name}`,
            busy: !!(busy && busy.action === 'delete'),
            disabled: !!busy,
            onClick: () => onAskDelete(skill),
          }),
        ),
        confirming ? h(ConfirmStrip, { skill, onCancel: cancelConfirm, onConfirm: onConfirmDelete }) : null,
        busy ? h('span', { className: 'dskp-row-busy', 'aria-hidden': 'true' }) : null,
      )
    }

    function Group({ id, icon, title, total, shown, filtering, rootPath, empty, children }) {
      return h(
        'section',
        { className: 'dskp-group', 'aria-labelledby': id },
        h(
          'div',
          { className: 'dskp-ghead' },
          h(Icon, { name: icon, size: 15, className: 'dskp-ghead-icon' }),
          h('h3', { id, className: 'dskp-ghead-title' }, title),
          h('span', { className: 'dskp-count' }, filtering ? `${shown} / ${total}` : String(total)),
          rootPath ? h(PathText, { path: rootPath, className: 'dskp-ghead-path' }) : null,
        ),
        shown ? h(React.Fragment, null, ...kids(children)) : h('div', { className: 'dskp-empty' }, h(Icon, { name: empty.icon, size: 15 }), h('span', null, empty.text)),
      )
    }

    function SkeletonGroup({ title, icon }) {
      return h(
        'section',
        { className: 'dskp-group', 'aria-hidden': 'true' },
        h('div', { className: 'dskp-ghead' }, h(Icon, { name: icon, size: 15, className: 'dskp-ghead-icon' }), h('span', { className: 'dskp-ghead-title' }, title)),
        [0, 1, 2].map((index) =>
          h(
            'div',
            { key: index, className: 'dskp-row dskp-row--skel' },
            h(
              'div',
              { className: 'dskp-info' },
              h('div', { className: 'dskp-line1' }, h('span', { className: 'dskp-skel', style: { width: `${34 + index * 9}%`, height: 12 } })),
              h(
                'div',
                { className: 'dskp-desc' },
                h('span', { className: 'dskp-skel', style: { width: '92%', height: 9, marginTop: 4 } }),
                h('span', { className: 'dskp-skel', style: { width: '61%', height: 9, marginTop: 8 } }),
              ),
              h('div', { className: 'dskp-path' }, h('span', { className: 'dskp-skel', style: { width: '48%', height: 8, marginTop: 4 } })),
            ),
            h('div', { className: 'dskp-side' }, h('span', { className: 'dskp-skel', style: { height: 28, borderRadius: 999 } })),
            h('div', null),
          ),
        ),
      )
    }

    function Diagnostics({ items, open, onToggle }) {
      const listId = useUid('diag')
      return h(
        'section',
        { className: 'dskp-diag' },
        h(
          'button',
          { type: 'button', className: 'dskp-diag-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': listId, onClick: onToggle },
          h(Icon, { name: 'alert', size: 15 }),
          h('span', null, `无法读取 ${items.length} 项`),
          h(Icon, { name: 'down', size: 14, className: cx('dskp-diag-caret', open && 'is-open') }),
        ),
        open
          ? h(
              'ul',
              { id: listId, className: 'dskp-diag-list' },
              items.map((item, index) => h('li', { key: index, className: 'dskp-diag-item' }, h('code', null, item.path), h('span', null, item.reason))),
            )
          : null,
      )
    }

    function Toasts({ items, onDismiss }) {
      return h(
        'div',
        { className: 'dskp-toasts', 'aria-live': 'polite' },
        items.map((toast) =>
          h(
            'div',
            { key: toast.id, className: cx('dskp-toast', `dskp-toast--${toast.kind}`), role: toast.kind === 'error' ? 'alert' : 'status' },
            h(Icon, { name: toast.kind === 'error' ? 'alert' : 'check', size: 16, className: 'dskp-toast-icon' }),
            h('div', { className: 'dskp-toast-text', title: toast.text }, toast.text),
            h(IconButton, { icon: 'x', label: '关闭提示', size: 13, className: 'dskp-toast-close', onClick: () => onDismiss(toast.id) }),
          ),
        ),
      )
    }

    /* =============================================================== 预览 */

    /** 拆出开头的 YAML frontmatter（与宿主 parseSkillDoc 同一判定），其余作为 Markdown 正文。 */
    function splitFrontmatter(text) {
      const raw = String(text || '').replace(/^﻿/, '')
      const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
      if (!match) return { fields: [], body: raw }
      return { fields: frontmatterEntries(match[1]), body: raw.slice(match[0].length) }
    }

    function unquoteScalar(value) {
      const text = value.trim()
      if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
      if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      return text
    }

    /** 只用于展示：顶层 `key: value`，`|` / `>` 块标量合并，嵌套结构保留原文。 */
    function frontmatterEntries(block) {
      const lines = String(block).split(/\r?\n/)
      const entries = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        const match = line && !/^\s/.test(line) && !line.trim().startsWith('#') ? /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line) : null
        index += 1
        if (!match) continue
        const rest = match[2].trim()
        const nested = []
        while (index < lines.length && (lines[index].trim() === '' || /^\s/.test(lines[index]))) {
          nested.push(lines[index])
          index += 1
        }
        while (nested.length && nested[nested.length - 1].trim() === '') nested.pop()
        let value
        if (/^[|>][+-]?$/.test(rest)) {
          const parts = nested.map((item) => item.replace(/^\s+/, ''))
          value = parts.join(rest.startsWith('|') ? '\n' : ' ').trim()
        } else if (!rest && nested.length) {
          const indent = Math.min(...nested.filter((item) => item.trim()).map((item) => item.match(/^\s*/)[0].length))
          value = nested.map((item) => item.slice(indent)).join('\n')
        } else {
          value = unquoteScalar([rest, ...nested.map((item) => item.trim())].join(' ').trim())
        }
        entries.push({ key: match[1], value })
      }
      return entries
    }

    /** 宿主渲染器抛错时只降级这一块，不让整个面板崩掉。 */
    class MarkdownBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidUpdate(previous) {
        if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false })
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    // name 已在标题栏、两个调用开关已由「启用」表达，预览里不再重复
    const FM_HIDDEN = new Set(['name', 'description', 'disable-model-invocation', 'user-invocable'])
    const FM_LABELS = {
      whenToUse: '适用场景',
      'when-to-use': '适用场景',
      version: '版本',
      license: '许可证',
      author: '作者',
      'allowed-tools': '允许的工具',
      metadata: '元数据',
    }

    /** frontmatter 作为文档摘要：description 是引言，其余字段紧凑列在下面。 */
    function FrontmatterSummary({ fields }) {
      const description = fields.find((entry) => entry.key === 'description')
      const extras = fields.filter((entry) => !FM_HIDDEN.has(entry.key))
      if (!(description && description.value) && !extras.length) return null
      return h(
        'header',
        { className: 'dskp-fm' },
        description && description.value
          ? h(React.Fragment, null, h('div', { className: 'dskp-fm-caption' }, '描述'), h('p', { className: 'dskp-fm-desc' }, description.value))
          : null,
        extras.length
          ? h(
              'dl',
              { className: 'dskp-fm-extra' },
              extras.map((entry, index) =>
                h(
                  'div',
                  { key: `${entry.key}-${index}`, className: 'dskp-fm-row' },
                  h('dt', { title: entry.key }, FM_LABELS[entry.key] || entry.key),
                  h('dd', null, entry.value === '' ? '—' : entry.value),
                ),
              ),
            )
          : null,
      )
    }

    function SkillPreview({ text }) {
      const parts = useMemo(() => splitFrontmatter(text), [text])
      const body = parts.body
      const plain = h('pre', { className: 'dskp-md-plain' }, body)
      return h(
        'div',
        null,
        h(FrontmatterSummary, { fields: parts.fields }),
        body.trim()
          ? h(
              'div',
              { className: 'dskp-md' },
              HostMarkdown ? h(MarkdownBoundary, { text: body, fallback: plain }, h(HostMarkdown, { text: body, labels: MARKDOWN_LABELS })) : plain,
            )
          : h('div', { className: 'dskp-preview-empty' }, '正文为空'),
      )
    }

    /* ============================================================= 详情页 */

    function DetailSheet({ skill, name, initialSource, project, onClose, onChanged }) {
      const layers = layersOf(skill)
      const [source, setSource] = useState(initialSource)
      const layer = layers.find((item) => item.source === source) || layers[0] || null
      const activeSource = layer ? layer.source : source

      const [doc, setDoc] = useState({ status: 'loading', content: '', original: '', path: '', size: 0, error: null })
      const [saving, setSaving] = useState(false)
      const [flagBusy, setFlagBusy] = useState(false)
      const [flagOverride, setFlagOverride] = useState(null)
      const [error, setError] = useState(null)
      const [savedAt, setSavedAt] = useState(0)
      const [askClose, setAskClose] = useState(false)
      const [mode, setMode] = useState('preview')
      const textRef = useRef(null)
      const focusEditor = useRef(false)
      const seq = useRef(0)
      const sheetRef = useRef(null)
      const keepRef = useRef(null)
      const titleId = useUid('detail')

      const ready = doc.status === 'ready'
      const dirty = ready && doc.content !== doc.original

      const loadDoc = useCallback(
        async (keep) => {
          const id = ++seq.current
          if (!keep) setDoc((prev) => ({ ...prev, status: 'loading', error: null }))
          try {
            const result = await getJson(api('doc', { project, name, source: activeSource }))
            if (id !== seq.current) return
            const text = typeof result.content === 'string' ? result.content : ''
            setDoc({ status: 'ready', content: text, original: text, path: result.path || '', size: Number(result.size) || 0, error: null })
          } catch (failure) {
            if (id !== seq.current) return
            if (keep) setError(`重新读取失败：${failure.message}`)
            else setDoc((prev) => ({ ...prev, status: 'error', error: failure.message }))
          }
        },
        [project, name, activeSource],
      )

      useEffect(() => {
        setError(null)
        setSavedAt(0)
        setAskClose(false)
        setFlagOverride(null)
        loadDoc(false)
      }, [loadDoc])

      useEffect(() => {
        focusQuietly(sheetRef.current)
      }, [])

      useEffect(() => {
        if (askClose) focusQuietly(keepRef.current)
      }, [askClose])

      // 用户点「编辑」后把焦点放进编辑框（首次打开不抢焦点）
      useEffect(() => {
        if (mode === 'edit' && focusEditor.current && textRef.current) {
          focusEditor.current = false
          focusQuietly(textRef.current)
        }
      }, [mode, doc.status])

      const switchMode = (next) => {
        focusEditor.current = next === 'edit'
        setMode(next)
      }

      const requestClose = () => {
        if (dirty) setAskClose(true)
        else onClose()
      }

      useEscapeLayer(true, () => {
        if (askClose) setAskClose(false)
        else requestClose()
        return true
      })

      // 一个「启用」开关同时管两行 frontmatter：开 = 模型与 /命令都可调用，关 = 都不可调用
      const modelOn = !!(layer && layer.modelInvocable)
      const userOn = !!(layer && layer.userInvocable)
      const enabled = flagOverride !== null ? flagOverride : modelOn && userOn
      const partial = flagOverride === null && modelOn !== userOn

      const toggleEnabled = async (next) => {
        if (!layer || dirty || saving || flagBusy) return
        setFlagBusy(true)
        setError(null)
        setFlagOverride(next)
        try {
          await postJson(api('flags', { project }), { name, source: layer.source, model: next, user: next })
          await onChanged()
          await loadDoc(true)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setFlagOverride(null)
          setFlagBusy(false)
        }
      }

      const save = async () => {
        if (!layer || !dirty || saving) return
        const content = doc.content
        setSaving(true)
        setError(null)
        try {
          await postJson(api('save', { project }), { name, source: layer.source, content })
          setDoc((prev) => ({ ...prev, original: content }))
          setSavedAt(Date.now())
          await onChanged()
          await loadDoc(true)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }

      const discard = () => {
        setDoc((prev) => ({ ...prev, content: prev.original }))
        setAskClose(false)
      }

      // 只有生效那一份（列表里的这一行）有 DSH 核对结果
      const layerIssue = layer && layer === skill ? dshProblem(skill.dsh) : null
      const lockFlags = !layer || !ready || dirty || saving
      const flagTitle = dirty ? '有未保存的修改' : partial ? invocationTitle(modelOn, userOn) : undefined

      let status = null
      let statusTone = ''
      if (saving) status = [h(Spinner, { key: 's', small: true }), '保存中']
      else if (dirty) {
        status = [h('span', { key: 'd', className: 'dskp-dot' }), '未保存']
        statusTone = 'is-dirty'
      } else if (savedAt) {
        status = [h(Icon, { key: 'c', name: 'check', size: 14 }), '已保存']
        statusTone = 'is-saved'
      } else if (ready) status = `${doc.content.split('\n').length} 行`

      let editor
      if (doc.status === 'loading') {
        editor = h('div', { className: 'dskp-editor dskp-editor--state' }, h(Spinner), h('span', null, '读取中'))
      } else if (doc.status === 'error') {
        editor = h(
          'div',
          { className: 'dskp-editor dskp-editor--state is-error', role: 'alert' },
          h(Icon, { name: 'alert', size: 20 }),
          h('span', null, doc.error),
          h(Button, { size: 'sm', icon: 'refresh', onClick: () => loadDoc(false) }, '重试'),
        )
      } else if (mode === 'preview') {
        editor = h('div', { className: 'dskp-preview-box', role: 'document', 'aria-label': `${name} 预览`, tabIndex: 0 }, h(SkillPreview, { text: doc.content }))
      } else {
        editor = h('textarea', {
          ref: textRef,
          className: 'dskp-editor',
          value: doc.content,
          spellCheck: false,
          readOnly: saving,
          'aria-label': `${name} SKILL.md`,
          onChange: (event) => {
            const value = event.target.value
            setDoc((prev) => ({ ...prev, content: value }))
            if (savedAt) setSavedAt(0)
          },
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 's') {
              event.preventDefault()
              save()
            }
          },
        })
      }

      return h(
        'div',
        { ref: sheetRef, className: 'dskp-sheet', role: 'dialog', 'aria-labelledby': titleId, tabIndex: -1 },
        h(
          'div',
          { className: 'dskp-sheet-head' },
          h(Button, { variant: 'ghost', size: 'sm', icon: 'back', onClick: requestClose }, '返回'),
          h(
            'div',
            { className: 'dskp-sheet-title' },
            h('h3', { id: titleId, className: 'dskp-sheet-name', title: name }, name),
            layer ? h(Tag, { mono: true }, `${scopeLabel(layer.scope)} · ${sourceLabel(layer.source)}`) : null,
            layer && layer.stub ? h(Tag, { tone: 'warn' }, '占位') : null,
            layerIssue ? h(Tag, { tone: 'error', title: layerIssue.title }, layerIssue.text) : null,
          ),
          h(IconButton, { icon: 'refresh', label: '重新读取', disabled: dirty || saving || doc.status === 'loading', onClick: () => loadDoc(false) }),
        ),
        h(
          'div',
          { className: 'dskp-sheet-meta' },
          h(PathText, { path: doc.path || (layer && layer.path) || '' }),
          ready ? h('span', { className: 'dskp-sheet-size' }, formatBytes(doc.size)) : null,
        ),
        h(
          'div',
          { className: 'dskp-sheet-bar' },
          h(FlagControl, {
            label: '启用',
            checked: enabled,
            partial,
            busy: flagBusy,
            disabled: lockFlags,
            title: flagTitle,
            onChange: toggleEnabled,
          }),
          h(
            'div',
            { className: 'dskp-bar-end' },
            layers.length > 1
              ? h(
                  'div',
                  { className: 'dskp-layers', role: 'group', 'aria-label': '同名副本' },
                  layers.map((item, index) => {
                    const on = item.source === activeSource
                    return h(
                      'button',
                      {
                        key: item.source,
                        type: 'button',
                        className: cx('dskp-layer', on && 'is-on'),
                        'aria-pressed': on ? 'true' : 'false',
                        disabled: !on && (dirty || saving || !!flagBusy),
                        title: item.path,
                        onClick: () => {
                          if (!on) setSource(item.source)
                        },
                      },
                      h('span', null, index === 0 ? (item.stub ? '占位' : '生效') : '被覆盖'),
                      h('span', { className: 'dskp-layer-src' }, sourceLabel(item.source)),
                    )
                  }),
                )
              : null,
            h(Segmented, {
              label: '查看方式',
              options: [
                { value: 'preview', label: '预览' },
                { value: 'edit', label: '编辑' },
              ],
              value: mode,
              onSelect: switchMode,
              className: 'dskp-seg--bar',
            }),
          ),
        ),
        error ? h('div', { className: 'dskp-sheet-alert' }, h(Alert, { text: error, onClose: () => setError(null) })) : null,
        h('div', { className: 'dskp-editor-wrap' }, editor),
        askClose
          ? h(
              'div',
              { className: 'dskp-sheet-foot' },
              h('div', { className: 'dskp-foot-status is-dirty', role: 'alert' }, h(Icon, { name: 'alert', size: 15 }), '放弃未保存的修改？'),
              h(Button, { ref: keepRef, onClick: () => setAskClose(false) }, '继续编辑'),
              h(Button, { variant: 'danger', onClick: onClose }, '放弃并返回'),
            )
          : h(
              'div',
              { className: 'dskp-sheet-foot' },
              h('div', { className: cx('dskp-foot-status', statusTone), 'aria-live': 'polite' }, status),
              h(Button, { variant: 'ghost', disabled: !dirty || saving, onClick: discard }, '放弃修改'),
              h(Button, { variant: 'primary', icon: 'check', busy: saving, disabled: !dirty || saving, onClick: save }, '保存'),
            ),
      )
    }

    /* ============================================================= 对话框 */

    function Dialog({ title, busy, onClose, initialFocusRef, footer, onDragOver, onDrop, children }) {
      const titleId = useUid('dlg')
      const cardRef = useRef(null)
      const downOnScrim = useRef(false)
      useEscapeLayer(true, () => {
        if (!busy) onClose()
        return true
      })
      useEffect(() => {
        focusQuietly((initialFocusRef && initialFocusRef.current) || cardRef.current)
      }, [])
      return h(
        'div',
        {
          className: 'dskp-scrim',
          onMouseDown: (event) => {
            downOnScrim.current = event.target === event.currentTarget
          },
          onClick: (event) => {
            if (downOnScrim.current && event.target === event.currentTarget && !busy) onClose()
            downOnScrim.current = false
          },
          onDragOver: (event) => {
            event.preventDefault()
            if (onDragOver) onDragOver(event)
          },
          onDrop: (event) => {
            event.preventDefault()
            if (onDrop) onDrop(event)
          },
        },
        h(
          'div',
          { ref: cardRef, className: 'dskp-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
          h(
            'div',
            { className: 'dskp-dialog-head' },
            h('h3', { id: titleId, className: 'dskp-dialog-title' }, title),
            h(IconButton, { icon: 'x', label: '关闭', disabled: busy, onClick: onClose }),
          ),
          h('div', { className: 'dskp-dialog-body' }, ...kids(children)),
          h('div', { className: 'dskp-dialog-foot' }, footer),
        ),
      )
    }

    function FormRow({ label, htmlFor, children }) {
      return h(
        React.Fragment,
        null,
        htmlFor ? h('label', { className: 'dskp-dlabel', htmlFor }, label) : h('div', { className: 'dskp-dlabel' }, label),
        h('div', { className: 'dskp-dfield' }, ...kids(children)),
      )
    }

    function scopeChoices(hasProject) {
      return [
        { value: 'global', label: '全局' },
        { value: 'project', label: '本项目', disabled: !hasProject, title: hasProject ? undefined : '没有项目目录' },
      ]
    }

    function CreateDialog({ skills, roots, hasProject, project, onClose, onCreated }) {
      const [scope, setScope] = useState(hasProject ? 'project' : 'global')
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [submitted, setSubmitted] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const nameRef = useRef(null)
      const formId = useUid('create')
      const nameId = useUid('name')
      const nameErrorId = useUid('name-err')
      const descId = useUid('desc')
      const descErrorId = useUid('desc-err')

      const trimmed = name.trim()
      const targetSource = scope === 'global' ? 'user-dsh' : 'project-dsh'
      const targetRoot = (roots.find((root) => root.source === targetSource) || {}).root || ''
      const exists = !!trimmed && skills.some((skill) => skill.name === trimmed && layersOf(skill).some((layer) => layer.source === targetSource))
      const nameError = trimmed
        ? !KEBAB.test(trimmed)
          ? '只能包含小写字母、数字和连字符'
          : exists
            ? '该位置已有同名技能'
            : null
        : submitted
          ? '请填写名称'
          : null
      const descError = submitted && !description.trim() ? '请填写描述' : null
      const valid = KEBAB.test(trimmed) && !exists && !!description.trim()

      const submit = async (event) => {
        if (event && event.preventDefault) event.preventDefault()
        if (busy) return
        setSubmitted(true)
        if (!valid) return
        setBusy(true)
        setError(null)
        try {
          await postJson(api('create', { project }), { name: trimmed, description: description.trim(), scope })
        } catch (failure) {
          setError(failure.message)
          setBusy(false)
          return
        }
        onCreated(trimmed)
      }

      return h(
        Dialog,
        {
          title: '新建技能',
          busy,
          onClose,
          initialFocusRef: nameRef,
          footer: [
            h(Button, { key: 'cancel', disabled: busy, onClick: onClose }, '取消'),
            h(Button, { key: 'submit', type: 'submit', form: formId, variant: 'primary', icon: 'plus', busy, disabled: busy }, '创建'),
          ],
        },
        h(
          'form',
          { id: formId, style: { display: 'contents' }, noValidate: true, onSubmit: submit },
          h(
            FormRow,
            { label: '位置' },
            h(Segmented, { label: '位置', options: scopeChoices(hasProject), value: scope, disabled: busy, onSelect: setScope, className: 'dskp-seg--inline' }),
            targetRoot ? h(PathText, { path: joinPath(targetRoot, trimmed || '…', 'SKILL.md'), className: 'dskp-target' }) : null,
          ),
          h(
            FormRow,
            { label: '名称', htmlFor: nameId },
            h('input', {
              id: nameId,
              ref: nameRef,
              className: cx('dskp-input', 'is-mono', nameError && 'is-invalid'),
              value: name,
              placeholder: 'my-skill',
              autoComplete: 'off',
              spellCheck: false,
              disabled: busy,
              'aria-invalid': nameError ? 'true' : undefined,
              'aria-describedby': nameError ? nameErrorId : undefined,
              onChange: (event) => setName(event.target.value),
            }),
            nameError ? h('div', { id: nameErrorId, className: 'dskp-field-error' }, nameError) : null,
          ),
          h(
            FormRow,
            { label: '描述', htmlFor: descId },
            h('textarea', {
              id: descId,
              className: cx('dskp-input', descError && 'is-invalid'),
              value: description,
              disabled: busy,
              'aria-invalid': descError ? 'true' : undefined,
              'aria-describedby': descError ? descErrorId : undefined,
              onChange: (event) => setDescription(event.target.value),
              onKeyDown: (event) => {
                const composing = event.nativeEvent && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                if (event.key === 'Enter' && !event.shiftKey && !composing) {
                  event.preventDefault()
                  submit()
                }
              },
            }),
            descError ? h('div', { id: descErrorId, className: 'dskp-field-error' }, descError) : null,
          ),
          error ? h('div', { className: 'dskp-span' }, h(Alert, { text: error, onClose: () => setError(null) })) : null,
        ),
      )
    }

    function ImportDialog({ roots, hasProject, project, onClose, onImported }) {
      const [mode, setMode] = useState('folder')
      const [scope, setScope] = useState(hasProject ? 'project' : 'global')
      const [folder, setFolder] = useState('')
      const [file, setFile] = useState(null)
      const [dragOver, setDragOver] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [results, setResults] = useState(null)
      const fileRef = useRef(null)
      const folderRef = useRef(null)
      const formId = useUid('import')
      const folderId = useUid('folder')

      const targetSource = scope === 'global' ? 'user-dsh' : 'project-dsh'
      const targetRoot = (roots.find((root) => root.source === targetSource) || {}).root || ''

      const pickFile = (candidate) => {
        if (!candidate) return
        if (!/\.zip$/i.test(candidate.name || '')) {
          setError('只支持 .zip 文件')
          return
        }
        if (candidate.size > MAX_ZIP_BYTES) {
          setError('压缩包超过 32MB 上限')
          return
        }
        setError(null)
        setResults(null)
        setFile(candidate)
      }

      const canSubmit = !busy && (mode === 'folder' ? !!folder.trim() : !!file)

      const submit = async (event) => {
        if (event && event.preventDefault) event.preventDefault()
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        setResults(null)
        try {
          let payload
          if (mode === 'folder') {
            const value = folder.trim().replace(/^"(.*)"$/, '$1')
            if (!isAbsolutePath(value)) throw new Error('请填写绝对路径')
            payload = await postJson(api('import-folder', { project }), { sourcePath: value, scope })
          } else {
            const bytes = await file.arrayBuffer()
            payload = await postBytes(api('import-zip', { project, scope, name: zipSkillName(file.name) }), bytes)
          }
          const list = Array.isArray(payload.results) ? payload.results : []
          setResults(list)
          await onImported(list)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const switchMode = (next) => {
        setMode(next)
        setError(null)
        setResults(null)
      }

      return h(
        Dialog,
        {
          title: '导入技能',
          busy,
          onClose,
          initialFocusRef: folderRef,
          onDragOver: () => {
            if (mode !== 'zip') switchMode('zip')
            if (!dragOver) setDragOver(true)
          },
          onDrop: (event) => {
            setDragOver(false)
            if (busy) return
            const files = event.dataTransfer && event.dataTransfer.files
            pickFile(files && files[0])
          },
          footer: [
            h(Button, { key: 'close', disabled: busy, onClick: onClose }, '关闭'),
            h(Button, { key: 'submit', type: 'submit', form: formId, variant: 'primary', icon: 'import', busy, disabled: !canSubmit }, '导入'),
          ],
        },
        h(
          'form',
          { id: formId, style: { display: 'contents' }, noValidate: true, onSubmit: submit },
          h(
            FormRow,
            { label: '来源' },
            h(Segmented, {
              label: '来源',
              options: [
                { value: 'folder', label: '文件夹' },
                { value: 'zip', label: 'zip' },
              ],
              value: mode,
              disabled: busy,
              onSelect: switchMode,
              className: 'dskp-seg--inline',
            }),
          ),
          h(
            FormRow,
            { label: '位置' },
            h(Segmented, { label: '位置', options: scopeChoices(hasProject), value: scope, disabled: busy, onSelect: setScope, className: 'dskp-seg--inline' }),
            targetRoot ? h(PathText, { path: targetRoot, className: 'dskp-target' }) : null,
          ),
          mode === 'folder'
            ? h(
                FormRow,
                { label: '路径', htmlFor: folderId },
                h('input', {
                  id: folderId,
                  ref: folderRef,
                  className: 'dskp-input is-mono',
                  value: folder,
                  placeholder: 'D:\\skills\\my-skill',
                  autoComplete: 'off',
                  spellCheck: false,
                  disabled: busy,
                  onChange: (event) => {
                    setFolder(event.target.value)
                    if (results) setResults(null)
                  },
                }),
              )
            : h(
                FormRow,
                { label: '文件' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: cx('dskp-drop', dragOver && 'is-over', file && 'has-file'),
                    disabled: busy,
                    onClick: () => fileRef.current && fileRef.current.click(),
                    onDragLeave: () => setDragOver(false),
                  },
                  h(Icon, { name: file ? 'file' : 'import', size: 20 }),
                  file
                    ? h('span', { className: 'dskp-drop-main' }, h('span', { className: 'dskp-drop-name', title: file.name }, file.name), h('span', { className: 'dskp-drop-meta' }, formatBytes(file.size)))
                    : h('span', { className: 'dskp-drop-main' }, h('span', null, '选择或拖入 .zip'), h('span', { className: 'dskp-drop-meta' }, '≤ 32 MB')),
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: '.zip,application/zip,application/x-zip-compressed',
                  tabIndex: -1,
                  style: { display: 'none' },
                  onChange: (event) => {
                    pickFile(event.target.files && event.target.files[0])
                    event.target.value = ''
                  },
                }),
              ),
          results
            ? h(
                'div',
                { className: 'dskp-span' },
                h(
                  'ul',
                  { className: 'dskp-results', 'aria-label': '导入结果' },
                  results.length
                    ? results.map((item, index) => {
                        const state = item.ok && item.dsh ? item.dsh.state : null
                        const unloaded = state === 'missing'
                        let detail
                        if (!item.ok) detail = h('span', { className: 'dskp-result-err' }, item.error || '失败')
                        else if (unloaded) detail = h('span', { className: 'dskp-result-err' }, '已复制，但 DSH 未加载：frontmatter 无法被 DSH 解析')
                        else if (state === 'other') detail = h('span', { className: 'dskp-result-meta' }, `已导入 · DSH 生效的是 ${sourceLabel(item.dsh.source)} 的同名技能`)
                        else detail = h('span', { className: 'dskp-result-meta' }, item.files ? `已导入 · ${item.files} 个文件` : '已导入')
                        return h(
                          'li',
                          { key: index, className: cx('dskp-result', item.ok && !unloaded ? 'is-ok' : 'is-fail') },
                          h(Icon, { name: !item.ok ? 'x' : unloaded ? 'alert' : 'check', size: 14 }),
                          h('span', { className: 'dskp-result-name', title: item.source || undefined }, item.name || baseName(item.source) || '未命名'),
                          detail,
                        )
                      })
                    : h('li', { className: 'dskp-result' }, '没有导入任何技能'),
                ),
              )
            : null,
          error ? h('div', { className: 'dskp-span' }, h(Alert, { text: error, onClose: () => setError(null) })) : null,
        ),
      )
    }

    /* ============================================================= 面板主体 */

    function SkillPanel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [loadError, setLoadError] = useState(null)
      const [pendingProject, setPendingProject] = useState(null)
      const [query, setQuery] = useState('')
      const [sheet, setSheet] = useState(null)
      const [confirmName, setConfirmName] = useState(null)
      const [busyRows, setBusyRows] = useState({})
      const [toasts, setToasts] = useState([])
      const [flash, setFlash] = useState(null)
      const [focusTarget, setFocusTarget] = useState(null)
      const [diagOpen, setDiagOpen] = useState(false)

      const rootRef = useRef(null)
      const mainRef = useRef(null)
      const scrollRef = useRef(null)
      const searchRef = useRef(null)
      const openerRef = useRef(null)
      const projectRef = useRef(readProject())
      const loadSeq = useRef(0)
      const hasData = useRef(false)
      const alive = useRef(true)
      const toastSeq = useRef(0)
      const toastTimers = useRef(null)
      if (!toastTimers.current) toastTimers.current = new Map()
      const globalHeadId = useUid('global')
      const projectHeadId = useUid('project')

      useEffect(() => {
        alive.current = true
        const timers = toastTimers.current
        return () => {
          alive.current = false
          timers.forEach((timer) => clearTimeout(timer))
          timers.clear()
        }
      }, [])

      // Esc：面板里有可关闭的层时，在捕获阶段先处理，不让设置弹窗一起关掉
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.isComposing) return
          const root = rootRef.current
          if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return
          for (let index = escapeLayers.length - 1; index >= 0; index -= 1) {
            if (escapeLayers[index](event) === true) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [])

      const dismissToast = useCallback((id) => {
        setToasts((list) => list.filter((toast) => toast.id !== id))
        const timer = toastTimers.current.get(id)
        if (timer) {
          clearTimeout(timer)
          toastTimers.current.delete(id)
        }
      }, [])

      const pushToast = useCallback(
        (kind, text) => {
          toastSeq.current += 1
          const id = toastSeq.current
          setToasts((list) => [...list.slice(-2), { id, kind, text }])
          if (kind !== 'error') toastTimers.current.set(id, setTimeout(() => dismissToast(id), 2600))
        },
        [dismissToast],
      )

      const load = useCallback(
        async (requested, options) => {
          const silent = !!(options && options.silent)
          loadSeq.current += 1
          const id = loadSeq.current
          if (silent) setRefreshing(true)
          else {
            setLoading(true)
            setLoadError(null)
          }
          try {
            const next = await getJson(api('list', { project: requested }))
            if (!alive.current || id !== loadSeq.current) return null
            hasData.current = true
            setData(next)
            setLoadError(null)
            projectRef.current = next.projectCwd || ''
            writeProject(next.projectCwd || '')
            return next
          } catch (failure) {
            if (!alive.current || id !== loadSeq.current) return null
            if (hasData.current) pushToast('error', `刷新失败：${failure.message}`)
            else setLoadError(failure.message)
            return null
          } finally {
            if (alive.current && id === loadSeq.current) {
              setLoading(false)
              setRefreshing(false)
            }
          }
        },
        [pushToast],
      )

      useEffect(() => {
        load(projectRef.current)
      }, [load])

      const refresh = useCallback(() => load(projectRef.current, { silent: hasData.current }), [load])

      const changeProject = async (value) => {
        setPendingProject(value)
        setConfirmName(null)
        await load(value, { silent: hasData.current })
        if (alive.current) setPendingProject(null)
      }

      /* ---------- 行操作：只锁当前行，结束后一律刷新 ---------- */

      const runRow = useCallback(
        async (skill, busyInfo, work, successText) => {
          const name = skill.name
          const root = rootRef.current
          const hadFocus = !!(root && document.activeElement && root.contains(document.activeElement))
          setConfirmName(null)
          setBusyRows((rows) => ({ ...rows, [name]: busyInfo }))
          let ok = false
          try {
            await work()
            ok = true
          } catch (failure) {
            pushToast('error', `${name}：${failure.message}`)
          }
          const next = await load(projectRef.current, { silent: true })
          if (!alive.current) return
          setBusyRows((rows) => {
            const copy = { ...rows }
            delete copy[name]
            return copy
          })
          if (ok) {
            pushToast('success', successText)
            if (next && (next.skills || []).some((item) => item.name === name)) setFlash({ name, token: Date.now() })
          }
          if (hadFocus) setFocusTarget({ name, token: Date.now() })
        },
        [load, pushToast],
      )

      const changeScope = useCallback(
        (skill, target) => {
          const text = skill.stub && target === 'global' ? `${skill.name} 已恢复全局` : `${skill.name} 已切到${scopeLabel(target)}`
          runRow(skill, { action: 'scope', target }, () => postJson(api('scope', { project: projectRef.current }), { name: skill.name, scope: target }), text)
        },
        [runRow],
      )

      const askDelete = useCallback((skill) => setConfirmName(skill.name), [])
      const cancelDelete = useCallback(() => setConfirmName(null), [])

      const confirmDelete = useCallback(
        (skill) => {
          if (skill.stub) {
            runRow(skill, { action: 'delete' }, () => postJson(api('scope', { project: projectRef.current }), { name: skill.name, scope: 'global' }), `${skill.name} 已恢复全局`)
            return
          }
          runRow(skill, { action: 'delete' }, () => postJson(api('delete', { project: projectRef.current }), { name: skill.name, source: skill.source }), `${skill.name} 已移到回收目录`)
        },
        [runRow],
      )

      /* ---------- 弹层 ---------- */

      const openSheet = useCallback((next) => {
        openerRef.current = document.activeElement
        setConfirmName(null)
        setSheet(next)
      }, [])

      const closeSheet = useCallback(() => setSheet(null), [])

      const openDetail = useCallback(
        (skill) => {
          const globalLayer = skill.stub ? globalLayerOf(skill) : null
          openSheet({ type: 'detail', name: skill.name, source: globalLayer ? globalLayer.source : skill.source })
        },
        [openSheet],
      )

      useEffect(() => {
        const main = mainRef.current
        if (main) main.inert = !!sheet
        if (!sheet) {
          const opener = openerRef.current
          openerRef.current = null
          if (opener && opener.isConnected && rootRef.current && rootRef.current.contains(opener)) focusQuietly(opener)
        }
      }, [sheet])

      const onCreated = useCallback(
        async (name) => {
          setSheet(null)
          pushToast('success', `已新建 ${name}`)
          const next = await load(projectRef.current, { silent: true })
          if (alive.current && next && (next.skills || []).some((item) => item.name === name)) setFlash({ name, token: Date.now() })
        },
        [load, pushToast],
      )

      const onImported = useCallback(
        async (list) => {
          const unloaded = list.filter((item) => item.ok && item.dsh && item.dsh.state === 'missing').length
          const imported = list.filter((item) => item.ok && item.name && !(item.dsh && item.dsh.state === 'missing')).map((item) => item.name)
          const failed = list.filter((item) => !item.ok).length
          const next = await load(projectRef.current, { silent: true })
          if (!alive.current) return
          if (imported.length) pushToast('success', failed ? `已导入 ${imported.length} 个，失败 ${failed} 个` : `已导入 ${imported.length} 个技能`)
          if (unloaded) pushToast('error', `${unloaded} 个技能已复制，但 DSH 未加载`)
          if (imported.length && next && (next.skills || []).some((item) => item.name === imported[0])) setFlash({ name: imported[0], token: Date.now() })
        },
        [load, pushToast],
      )

      // 刷新后把刚变动的那一行滚进视野并高亮
      useEffect(() => {
        if (!flash) return undefined
        const scroller = scrollRef.current
        const row = scroller && scroller.querySelector(`[data-skill="${cssEscape(flash.name)}"]`)
        if (row) revealRow(scroller, row)
        const timer = setTimeout(() => setFlash((current) => (current === flash ? null : current)), 1900)
        return () => clearTimeout(timer)
      }, [flash])

      // 行操作期间按钮被禁用 / 行被移走，焦点会掉出面板；操作结束后把它放回这一行
      useEffect(() => {
        if (!focusTarget) return
        const root = rootRef.current
        const active = document.activeElement
        if (!root || (active && active !== document.body && root.contains(active))) return
        const scroller = scrollRef.current
        const row = scroller && scroller.querySelector(`[data-skill="${cssEscape(focusTarget.name)}"]`)
        const target = row ? row.querySelector('.dskp-seg-btn.is-on') || row.querySelector('button:not([disabled]):not([tabindex="-1"])') : searchRef.current
        focusQuietly(target)
      }, [focusTarget])

      useEscapeLayer(!!query, (event) => {
        if (event.target !== searchRef.current) return false
        setQuery('')
        return true
      })

      /* ---------- 派生数据 ---------- */

      const project = (data && data.projectCwd) || ''
      const hasProject = !!(data && data.projectRoot)
      const skills = (data && data.skills) || []
      const roots = (data && data.roots) || []
      const diagnostics = (data && data.diagnostics) || []
      const keyword = query.trim().toLowerCase()
      const filtering = !!keyword

      const groups = useMemo(() => {
        const globalAll = skills.filter((skill) => skill.scope === 'global' || skill.stub)
        const projectAll = skills.filter((skill) => skill.scope === 'project' && !skill.stub)
        return {
          globalAll,
          projectAll,
          globalShown: globalAll.filter((skill) => matchesSkill(skill, keyword)),
          projectShown: projectAll.filter((skill) => matchesSkill(skill, keyword)),
        }
      }, [skills, keyword])

      const workspaceOptions = useMemo(() => {
        const options = ((data && data.workspaces) || []).map((workspace) => ({ value: workspace.path, label: workspace.title || baseName(workspace.path) }))
        if (project && !options.some((option) => option.value === project)) options.unshift({ value: project, label: baseName(project) })
        return options
      }, [data, project])

      const rootOf = (source) => {
        const root = roots.find((item) => item.source === source)
        return root ? root.root : ''
      }

      const selectValue = pendingProject !== null ? pendingProject : project
      const detailSkill = sheet && sheet.type === 'detail' ? skills.find((skill) => skill.name === sheet.name) || null : null

      /* ---------- 渲染 ---------- */

      let listContent
      if (!data) {
        listContent = loadError
          ? h(
              'div',
              { className: 'dskp-state' },
              h(Icon, { name: 'alert', size: 24, className: 'dskp-state-icon' }),
              h('div', { className: 'dskp-state-msg', role: 'alert' }, loadError),
              h(Button, { icon: 'refresh', onClick: () => load(projectRef.current) }, '重试'),
            )
          : [h(SkeletonGroup, { key: 'g', title: '全局技能', icon: 'globe' }), h(SkeletonGroup, { key: 'p', title: '本项目技能', icon: 'folder' })]
      } else {
        const renderRow = (skill) =>
          h(SkillRow, {
            key: skill.name,
            skill,
            hasProject,
            busy: busyRows[skill.name] || null,
            confirming: confirmName === skill.name,
            flashToken: flash && flash.name === skill.name ? flash.token : 0,
            onScope: changeScope,
            onOpen: openDetail,
            onAskDelete: askDelete,
            onCancelDelete: cancelDelete,
            onConfirmDelete: confirmDelete,
          })
        listContent = [
          h(
            Group,
            {
              key: 'global',
              id: globalHeadId,
              icon: 'globe',
              title: '全局技能',
              total: groups.globalAll.length,
              shown: groups.globalShown.length,
              filtering,
              rootPath: rootOf('user-dsh'),
              empty: filtering ? { icon: 'search', text: '没有匹配的全局技能' } : { icon: 'globe', text: '没有全局技能' },
            },
            groups.globalShown.map(renderRow),
          ),
          h(
            Group,
            {
              key: 'project',
              id: projectHeadId,
              icon: 'folder',
              title: '本项目技能',
              total: groups.projectAll.length,
              shown: groups.projectShown.length,
              filtering,
              rootPath: hasProject ? rootOf('project-dsh') : '',
              empty: !hasProject
                ? { icon: 'folder', text: '没有项目目录' }
                : filtering
                  ? { icon: 'search', text: '没有匹配的本项目技能' }
                  : { icon: 'folder', text: '没有本项目技能' },
            },
            groups.projectShown.map(renderRow),
          ),
          diagnostics.length ? h(Diagnostics, { key: 'diag', items: diagnostics, open: diagOpen, onToggle: () => setDiagOpen((value) => !value) }) : null,
        ]
      }

      return h(
        'div',
        { ref: rootRef, className: 'dskp-root' },
        h('style', null, STYLE),
        h(
          'div',
          { ref: mainRef, className: 'dskp-main' },
          h(
            'div',
            { className: 'dskp-toolbar' },
            h(ProjectPicker, { value: selectValue, options: workspaceOptions, onChange: changeProject }),
            h(
              'div',
              { className: 'dskp-field dskp-search' },
              h(Icon, { name: 'search', size: 15 }),
              h('input', {
                ref: searchRef,
                type: 'text',
                value: query,
                placeholder: '搜索技能',
                title: '按名称、描述、路径搜索',
                'aria-label': '搜索技能',
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => {
                  setQuery(event.target.value)
                  setConfirmName(null)
                },
              }),
              query
                ? h(IconButton, {
                    icon: 'x',
                    label: '清空搜索',
                    size: 14,
                    className: 'dskp-clear',
                    onClick: () => {
                      setQuery('')
                      focusQuietly(searchRef.current)
                    },
                  })
                : null,
            ),
            h(IconButton, {
              icon: 'refresh',
              label: '刷新',
              className: cx('dskp-ibtn--boxed', (refreshing || loading) && 'is-spinning'),
              'aria-busy': refreshing || loading ? 'true' : undefined,
              onClick: () => {
                if (!refreshing && !loading) refresh()
              },
            }),
            h(Button, { icon: 'import', disabled: !data, onClick: () => openSheet({ type: 'import' }) }, '导入'),
            h(Button, { variant: 'primary', icon: 'plus', disabled: !data, onClick: () => openSheet({ type: 'create' }) }, '新建'),
          ),
          h(
            'div',
            { className: 'dskp-card' },
            refreshing ? h('div', { className: 'dskp-progress', 'aria-hidden': 'true' }) : null,
            h('div', { ref: scrollRef, className: 'dskp-scroll', 'aria-busy': loading || refreshing ? 'true' : undefined }, listContent),
          ),
        ),
        h(Toasts, { items: toasts, onDismiss: dismissToast }),
        sheet && sheet.type === 'detail'
          ? h(DetailSheet, {
              key: `detail:${sheet.name}`,
              skill: detailSkill,
              name: sheet.name,
              initialSource: sheet.source,
              project,
              onClose: closeSheet,
              onChanged: refresh,
            })
          : null,
        sheet && sheet.type === 'create'
          ? h(CreateDialog, { skills, roots, hasProject, project, onClose: closeSheet, onCreated })
          : null,
        sheet && sheet.type === 'import' ? h(ImportDialog, { roots, hasProject, project, onClose: closeSheet, onImported }) : null,
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
