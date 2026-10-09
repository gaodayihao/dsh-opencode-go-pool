// Client half of dsh-opencode-go-pool.
//
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
//
// Four surfaces, one data layer:
//
//   * `settings.section` — the "OpenCode Go 套餐池" page. Laid out like the
//     harness's own settings pages and like the Command Code provider's:
//     titled groups separated by hairlines, each row a title/description on the
//     left and its control on the right. Accounts (one slim card per credential)
//     open the page; Models and Integrations & display follow; Advanced is a
//     collapsed disclosure.
//   * `main` keyed `opencode-go-pool-panel` — the quota dashboard the sidebar
//     card opens in the center column.
//   * `sidebar.footer.action` — the opt-in quota card at the sidebar foot.
//
// Everything reads one `createPoolStore`, which is also where the fix for the
// permanent "查询中…" lives: the host's `status()` is a pure in-memory read, so
// the page paints as soon as it answers, and `usage()` (the only network call)
// is a separate, explicitly requested pass whose results are merged in when
// they land.

window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-pool',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    const NS = 'settings.opencodeGoPool';
    const PANEL_NS = 'panel.opencodeGoPool';
    const inject = ['slots', 'locale', 'remote'];

    /** The layout's `MainPanelId` shared by the sidebar card and the panel cell. */
    const PANEL_ID = 'opencode-go-pool-panel';
    const CSS_ID = 'dsh-opencode-go-pool/opencode-go-pool.css';
    const DEFAULT_POLL_MS = 30000;
    const MAX_TIMEOUT_MS = 3600000;

    // ------------------------------------------------------------------ copy

    const zh = {
      // The sidebar entry is short on purpose: the settings nav column is
      // narrow, and the full name is what the page title is for.
      nav: 'OpenCode Go',
      title: 'OpenCode Go 套餐池',
      subtitle: '多 Key 池 · 额度耗尽自动切换',
      loading: '查询中…',
      loadFailed: '加载失败',
      paused: '连续失败，已暂停自动刷新',
      refresh: '刷新',
      refreshing: '刷新中…',
      reload: '重新加载',
      updatedAt: '更新于',

      takeoverServing: '服务中 · 路由 opencode-go 已接管',
      takeoverOwnRoute: '自有路由模式 · opencode-go-pool',
      takeoverWaiting: '等待接管',
      takeoverWaitingHint: 'opencode-go 路由当前由其他插件持有。请在「设置 → 模型」中删除 opencode-go 供应商行，本插件会自动接管，历史会话无需任何改动。',
      takeoverBadgeServing: '已接管',
      takeoverBadgeOwn: '自有路由',
      takeoverBadgeWaiting: '等待接管',
      unsavedChanges: '有未保存的更改',
      saveInvalid: '有无效的数值，保存已停用',
      saving: '保存中…',
      discard: '放弃修改',
      settingsUnavailable: '当前 DSH 运行时不提供可写的设置接口',
      lastSwitch: '最近切换',
      switchQuota: '额度耗尽',
      switchConsecutive: '连续失败',
      switchInvalid: '凭据失效',
      switchManual: '手动',

      accountsTitle: '账户',
      accountsHint: '每个账户就是一个 OpenCode Go 的 Key。密钥只写入凭据服务，不进入任何设置文档。',
      accountsRotationHint: '多个账户按配置顺序轮转；额度耗尽或凭据失效时自动切到下一个可用账户。',
      accountModeAuto: '当前为自动轮转',
      accountModePinned: '当前固定使用「{name}」',
      accountAdd: '添加账户',
      accountActions: '账户操作',
      accountActionKey: '编辑凭据（密钥）',
      accountActionRename: '重命名',
      accountActionRemove: '删除账户',
      accountActionPin: '设为当前使用',
      accountKeyPlaceholder: '粘贴 sk-... 密钥',
      accountNamePlaceholder: '显示名，如 主号',
      accountApply: '应用',
      accountNoKeyHint: '尚未填写密钥，这个账户暂时不可用。',
      accountReconfigureHint: '修改密钥后会自动清除「已失效」标记并重新查询额度。',
      accountRemoveConfirm: '删除账户「{name}」？该账户的运行状态会一并清除。',
      accountConfirmRemove: '确认删除',
      apiKeyUnset: '未配置密钥',
      activeBadge: '使用中',
      idleBadge: '空闲',
      exhaustedBadge: '额度耗尽',
      invalidBadge: '已失效',
      disabledBadge: '已停用',
      lastFailure: '最近失败',

      rolling: '5 小时滚动',
      weekly: '每周',
      monthly: '每月',
      used: '已用',
      left: '剩余',
      resets: '重置',
      credentialRef: '凭据引用',
      usagePending: '查询中…',
      usageUpdated: '数据更新于',
      noApiKey: '未配置凭据，等待填写',
      unauthorized: 'Key 无效或已过期（401）',
      network: '网络请求失败',
      badJson: '接口响应解析失败',
      httpError: '接口返回 HTTP {status}',
      unknown: '未知',
      windowUnlimited: '不限',

      strategyTitle: '切号策略',
      strategyHint: '避让：5 小时滚动窗口或每周窗口任一达到阈值即提前切走（100 = 仅失败时切）。连败：模型调用失败累计 N 次切号（0 = 关闭）。额度耗尽或凭据失效始终立即切换。',
      preemptLabel: '5h/每周用量达到 % 自动切号',
      consecLabel: '连续失败次数达到后自动切号',
      save: '保存',
      saved: '已保存',
      saveFailed: '保存失败',
      overridden: '已自定义',
      reset: '恢复默认',
      invalidNumber: '请填数字',
      numberTooSmall: '数值太小',
      numberTooLarge: '数值太大',
      durationInvalid: '请填秒数（最多三位小数）',
      durationTooSmall: '不能小于 1 秒',
      durationTooLarge: '不能超过 3600 秒',

      modelsTitle: '模型',
      modelsHint: '控制哪些模型出现在对话的模型下拉里；未勾选的模型不可发起请求。',
      modelsRange: '模型范围',
      modelsRangeHint: '「全部模型」跟随官方目录，新模型自动可用；自定义只暴露勾选的模型。',
      allModels: '全部模型（跟随官方目录）',
      modelCount: '已启用 {n} 个模型',
      modelNone: '未选择任何模型：该供应商暂时不可用',
      modelUnavailable: '模型目录暂不可用，稍后刷新重试',
      modelEmptyHint: '自定义选择至少需要勾选一个模型',
      modelFetch: '拉取模型',
      modelFetching: '拉取中…',
      modelFetched: '已获取 {count} 个模型，新增 {added} 个',
      modelFetchFailed: '拉取模型失败',
      modelFetchHint: '从官方 models 接口拉取最新模型；目录里还没有的新模型按默认协议接入（思考强度与 DeepSeek V4 一致），勾选后即可尝试使用',
      modelExpand: '展开',
      modelCollapse: '收起',
      dynamicTag: '动态',

      integrationsTitle: '集成与显示',
      integrationsHint: '对话之外复用本插件的界面。',
      showSidebarQuota: '在侧边栏显示额度卡片',
      showSidebarQuotaHint: '在侧边栏底部（设置上方）显示余额卡片，点击打开额度面板。默认关闭；关闭时不发起任何额度查询。',

      advancedTitle: '高级设置',
      advancedHint: '网络请求的超时与重试。除非遇到超时或断连，否则保持默认即可。',
      advancedOverridden: '已自定义 {n} 项',
      advancedInvalid: '有无效数值',
      advancedExpand: '展开',
      advancedCollapse: '收起',
      requestTimeout: '请求超时（秒）',
      requestTimeoutHint: '等待响应首个字节的超时；默认 300 秒。上游模型较慢时可调高。',
      streamIdleTimeout: '流空闲超时（秒）',
      streamIdleTimeoutHint: '生成流停滞多久视为死连接；默认 300 秒（长思考模型可静默数分钟，默认值刻意放宽）。',
      transportMaxRetries: '网络失败重试次数',
      transportMaxRetriesHint: '连接失败时自动重试几次，默认 5（各次等待 0.5+1+2+4+8 秒，合计约 15 秒）。',

      noKeysTitle: '尚未配置账户',
      noKeysHint: '每个账户对应一个 OpenCode Go 账号。点击下方「添加账户」，粘贴密钥即可，密钥写入凭据服务。',
      confirmSwitch: '立即切换到该账户？',
      confirmDisable: '停用该账户？停用后不再参与自动切换。',
      confirmClear: '清除失效标记？请确认已在凭据中修复该 Key。',
      actionFailed: '操作失败',
      cancel: '取消',
      show: '显示',
      hide: '隐藏',
      remove: '删除',

      panelTitle: 'OpenCode Go 额度',
      panelSubtitle: '各账户的 5 小时滚动 / 每周 / 每月用量',
      close: '关闭额度面板',
      closeHint: '返回对话（当前会话不受影响）',
      footNoData: '暂无额度数据',
    };

    const en = {
      nav: 'OpenCode Go',
      title: 'OpenCode Go Pool',
      subtitle: 'Multi-key pool · automatic quota failover',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      paused: 'repeated failures, auto-refresh paused',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      reload: 'Reload',
      updatedAt: 'updated',

      takeoverServing: 'Serving · opencode-go route taken over',
      takeoverOwnRoute: 'Own route mode · opencode-go-pool',
      takeoverWaiting: 'Waiting for takeover',
      takeoverWaitingHint: 'The opencode-go route is currently owned by another plugin. Remove the opencode-go row under Settings → Models and this plugin takes over automatically — existing conversations keep working unchanged.',
      takeoverBadgeServing: 'serving',
      takeoverBadgeOwn: 'own route',
      takeoverBadgeWaiting: 'waiting',
      unsavedChanges: 'Unsaved changes',
      saveInvalid: 'Some values are invalid, saving is disabled',
      saving: 'Saving…',
      discard: 'Discard',
      settingsUnavailable: 'This DSH runtime exposes no writable settings seam',
      lastSwitch: 'last switch',
      switchQuota: 'quota',
      switchConsecutive: 'consecutive failures',
      switchInvalid: 'credential',
      switchManual: 'manual',

      accountsTitle: 'Accounts',
      accountsHint: 'Each account is one OpenCode Go key. Secrets go to the credentials service only — never into a settings document.',
      accountsRotationHint: 'Accounts rotate in configuration order; a spent quota or a rejected credential switches to the next usable account automatically.',
      accountModeAuto: 'rotating automatically',
      accountModePinned: 'pinned to “{name}”',
      accountAdd: 'Add account',
      accountActions: 'Account actions',
      accountActionKey: 'Edit credential (key)',
      accountActionRename: 'Rename',
      accountActionRemove: 'Remove account',
      accountActionPin: 'Use this account now',
      accountKeyPlaceholder: 'paste the sk-... secret',
      accountNamePlaceholder: 'display name, e.g. main',
      accountApply: 'Apply',
      accountNoKeyHint: 'No key stored yet — this account cannot serve requests.',
      accountReconfigureHint: 'Applying a new secret clears the invalid mark and re-queries usage.',
      accountRemoveConfirm: 'Remove “{name}”? Its runtime state is cleared too.',
      accountConfirmRemove: 'Remove',
      apiKeyUnset: 'no key stored',
      activeBadge: 'in use',
      idleBadge: 'idle',
      exhaustedBadge: 'quota exhausted',
      invalidBadge: 'invalid',
      disabledBadge: 'disabled',
      lastFailure: 'last failure',

      rolling: '5h rolling',
      weekly: 'Weekly',
      monthly: 'Monthly',
      used: 'used',
      left: 'left',
      resets: 'resets',
      credentialRef: 'credential ref',
      usagePending: 'Loading…',
      usageUpdated: 'usage updated',
      noApiKey: 'credential not set yet',
      unauthorized: 'key rejected (401)',
      network: 'network request failed',
      badJson: 'bad JSON from the usage endpoint',
      httpError: 'usage endpoint answered HTTP {status}',
      unknown: 'unknown',
      windowUnlimited: 'uncapped',

      strategyTitle: 'Switching strategy',
      strategyHint: 'Avoid: switch ahead once the 5h rolling OR weekly window reaches the threshold (100 = fail-only). Consecutive: switch after N accumulated call failures (0 = off). Quota exhaustion or an invalid credential always switches immediately.',
      preemptLabel: 'Auto-switch at 5h/weekly usage %',
      consecLabel: 'Switch after N consecutive failures',
      save: 'Save',
      saved: 'Saved',
      saveFailed: 'Save failed',
      overridden: 'customized',
      reset: 'Reset to default',
      invalidNumber: 'enter a number',
      numberTooSmall: 'too small',
      numberTooLarge: 'too large',
      durationInvalid: 'enter seconds (up to three decimals)',
      durationTooSmall: 'cannot be below 1 second',
      durationTooLarge: 'cannot exceed 3600 seconds',

      modelsTitle: 'Models',
      modelsHint: 'Controls which models appear in the chat model dropdown; unchecked models cannot be used.',
      modelsRange: 'Model range',
      modelsRangeHint: '“All models” follows the official catalog so new models appear automatically; a custom selection exposes exactly the checked ones.',
      allModels: 'All models (follow the catalog)',
      modelCount: '{n} models enabled',
      modelNone: 'No model selected: the provider is temporarily unusable',
      modelUnavailable: 'Model catalog unavailable — try refreshing later',
      modelEmptyHint: 'Custom selection needs at least one model',
      modelFetch: 'Fetch models',
      modelFetching: 'Fetching…',
      modelFetched: 'Fetched {count} models, {added} new',
      modelFetchFailed: 'Failed to fetch models',
      modelFetchHint: 'Pull the latest models from the official models endpoint; new models are wired up with a default protocol (thinking levels like DeepSeek V4) and become usable once checked',
      modelExpand: 'Expand',
      modelCollapse: 'Collapse',
      dynamicTag: 'dynamic',

      integrationsTitle: 'Integrations & display',
      integrationsHint: 'Surfaces outside chat that reuse this plugin.',
      showSidebarQuota: 'Show the quota card in the sidebar',
      showSidebarQuotaHint: 'Shows the balance card at the sidebar foot (above Settings); clicking it opens the quota dashboard. Off by default, and while off no usage query is made at all.',

      advancedTitle: 'Advanced',
      advancedHint: 'Request timeouts and retries. Leave the defaults alone unless you are hitting timeouts or dropped connections.',
      advancedOverridden: '{n} customized',
      advancedInvalid: 'invalid value',
      advancedExpand: 'Expand',
      advancedCollapse: 'Collapse',
      requestTimeout: 'Request timeout (seconds)',
      requestTimeoutHint: 'How long to wait for the first response byte; default 300 s (the official CLI’s). Raise it when a slow upstream outlasts the default.',
      streamIdleTimeout: 'Stream idle timeout (seconds)',
      streamIdleTimeoutHint: 'How long a stalled stream is treated as dead; default 300 s (long-thinking models can be silent for minutes, so the default is deliberately loose).',
      transportMaxRetries: 'Transport retries',
      transportMaxRetriesHint: 'How many times a failed connection is retried automatically; default 5 (waits of 0.5+1+2+4+8 s, about 15 s in total).',

      noKeysTitle: 'No accounts configured',
      noKeysHint: 'Each account is one OpenCode Go account. Click “Add account” below and paste the key — it is written to the credentials service.',
      confirmSwitch: 'Switch to this account now?',
      confirmDisable: 'Disable this account? It stops taking part in failover.',
      confirmClear: 'Clear the invalid mark? Make sure the credential is fixed first.',
      actionFailed: 'Action failed',
      cancel: 'Cancel',
      show: 'Show',
      hide: 'Hide',
      remove: 'Remove',

      panelTitle: 'OpenCode Go quota',
      panelSubtitle: '5h rolling / weekly / monthly usage per account',
      close: 'Close the quota dashboard',
      closeHint: 'Back to the conversation (the current session is untouched)',
      footNoData: 'no usage data yet',
    };

    const panelZh = {
      nav: zh.nav, panelTitle: zh.panelTitle, panelSubtitle: zh.panelSubtitle,
      close: zh.close, closeHint: zh.closeHint, refresh: zh.refresh, refreshing: zh.refreshing,
      loading: zh.loading, updatedAt: zh.updatedAt, noKeysTitle: zh.noKeysTitle, noKeysHint: zh.noKeysHint,
      rolling: zh.rolling, weekly: zh.weekly, monthly: zh.monthly,
      used: zh.used, left: zh.left, resets: zh.resets, unknown: zh.unknown,
      activeBadge: zh.activeBadge, exhaustedBadge: zh.exhaustedBadge, invalidBadge: zh.invalidBadge,
      disabledBadge: zh.disabledBadge, idleBadge: zh.idleBadge, apiKeyUnset: zh.apiKeyUnset,
      usagePending: zh.usagePending, noApiKey: zh.noApiKey, unauthorized: zh.unauthorized,
      network: zh.network, badJson: zh.badJson, httpError: zh.httpError,
      loadFailed: zh.loadFailed, footNoData: zh.footNoData,
    };
    const panelEn = {
      nav: en.nav, panelTitle: en.panelTitle, panelSubtitle: en.panelSubtitle,
      close: en.close, closeHint: en.closeHint, refresh: en.refresh, refreshing: en.refreshing,
      loading: en.loading, updatedAt: en.updatedAt, noKeysTitle: en.noKeysTitle, noKeysHint: en.noKeysHint,
      rolling: en.rolling, weekly: en.weekly, monthly: en.monthly,
      used: en.used, left: en.left, resets: en.resets, unknown: en.unknown,
      activeBadge: en.activeBadge, exhaustedBadge: en.exhaustedBadge, invalidBadge: en.invalidBadge,
      disabledBadge: en.disabledBadge, idleBadge: en.idleBadge, apiKeyUnset: en.apiKeyUnset,
      usagePending: en.usagePending, noApiKey: en.noApiKey, unauthorized: en.unauthorized,
      network: en.network, badJson: en.badJson, httpError: en.httpError,
      loadFailed: en.loadFailed, footNoData: en.footNoData,
    };

    // ----------------------------------------------------------------- style

    // The metrics are the harness's own settings pages', so the page sits
    // beside General and Models without looking foreign: a group is a title over
    // its rows with a hairline between GROUPS (never inside one), a row is 12px
    // of padding with the title/description left and the control right, an
    // account card is a 0.5px outline with a 16px radius, and the kebab is three
    // dots from one element. Colours are harness theme aliases with neutral
    // fallbacks; every selector carries an `ogp-` class of our own, except the
    // two sidebar-anchor rules, which say why they cannot.
    const CSS = `
/* The sidebar's foot is a flex ROW whose occupants each declare a full-width
   line; a card that cannot shrink would be squeezed by the neighbouring chip.
   THE ANCHOR IS LOAD-BEARING: "footerActions" is not a stem the shell owns
   alone (dsh-client-ui-user-questions renders its dialog button row with it),
   while "footArea" is declared by dsh-client-ui-sidebar alone. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}

.ogp-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.ogp-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.ogp-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ogp-header{align-items:flex-start;gap:10px;display:flex;flex-wrap:wrap}
.ogp-spacer{flex:1}
.ogp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ogp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.ogp-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}

/* A group: heading over its rows, hairline only between groups. */
.ogp-group{flex-direction:column;display:flex;margin-top:28px}
.ogp-groupDivided{margin-top:24px;padding-top:20px;border-top:.5px solid var(--dsw-alias-border-l2)}
.ogp-groupHead{align-items:center;gap:8px;display:flex;min-height:28px;padding-bottom:4px}
.ogp-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.ogp-groupDesc{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ogp-disclosure{width:100%;padding:0 0 4px;border:0;background:0 0;font:inherit;text-align:left;cursor:pointer;border-radius:6px}
.ogp-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ogp-rows{flex-direction:column;display:flex}

.ogp-row{align-items:center;gap:8px;display:flex;padding:12px 0}
.ogp-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:32px;display:flex}
.ogp-rowTitleLine{align-items:center;gap:8px;display:flex;min-width:0}
.ogp-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.ogp-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ogp-rowDesc p{margin:0}
.ogp-rowDesc p+p{margin-top:4px}
.ogp-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.ogp-rowControl{flex:none;align-items:center;justify-content:flex-end;gap:8px;display:inline-flex;max-width:60%;flex-wrap:wrap}

.ogp-input{box-sizing:border-box;height:32px;min-width:0;width:200px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-variant-numeric:tabular-nums}
.ogp-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.ogp-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.ogp-input:disabled{opacity:.6;cursor:default}
.ogp-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.ogp-inputNarrow{width:110px}

.ogp-button{box-sizing:border-box;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;white-space:nowrap;cursor:pointer}
.ogp-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ogp-button:disabled{cursor:default;opacity:.4}
.ogp-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.ogp-buttonPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.ogp-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}
.ogp-buttonDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ogp-linkButton{box-sizing:border-box;flex:none;align-items:center;display:inline-flex;height:28px;padding:0 10px;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.ogp-linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ogp-linkButton:disabled{cursor:default;opacity:.4}

.ogp-badge,.ogp-badgeMuted{flex:none;align-items:center;display:inline-flex;white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:500;line-height:17px}
.ogp-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.ogp-badgeMuted{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.ogp-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.ogp-badgeOk{background:var(--dsw-alias-state-success-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-success-primary,#16a34a)}
.ogp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}

.ogp-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative;cursor:pointer}
.ogp-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ogp-check:checked::after{content:'';position:absolute;top:3px;left:5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.ogp-check:disabled{cursor:default;opacity:.4}
.ogp-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.ogp-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* A toggle modelled on the platform's Switch: corner-shape:round on both the
   track and the thumb, and no literal colours (brand-primary inverts between
   light and dark, so a hardcoded white thumb vanishes in dark mode). */
.ogp-toggle{box-sizing:border-box;appearance:none;flex-shrink:0;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;position:relative}
.ogp-toggle:checked{background:var(--dsw-alias-brand-primary)}
.ogp-toggle::after{content:'';display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.ogp-toggle:checked::after{transform:translateX(16px)}
.ogp-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ogp-toggle:disabled{cursor:default;opacity:.5}
.ogp-chevron{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:7px;height:7px;margin-right:6px;margin-bottom:3px;transform:rotate(45deg);transition:transform .15s ease}
.ogp-chevronUp{transform:rotate(-135deg);margin-bottom:-3px}

/* ------------------------------------------------------------ accounts */
.ogp-accountList{flex-direction:column;gap:8px;display:flex}
/* A slim row card: the head is one line, the meters a second, and everything
   else lives behind the disclosure. */
.ogp-accountItem{flex-direction:column;gap:8px;display:flex;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px}
.ogp-accountItemActive{border-color:var(--dsw-static-neutral-bluish-400,var(--dsw-alias-border-l3))}
.ogp-accountHead{align-items:center;gap:4px;display:flex;min-height:28px}
.ogp-accountToggle{align-items:center;gap:8px;display:flex;flex:1;min-width:0;padding:0;background:0 0;border:0;color:inherit;cursor:pointer;font:inherit;text-align:left}
.ogp-accountToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.ogp-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.ogp-dot{flex-shrink:0;width:8px;height:8px;border-radius:50%}
.ogp-dotOk{background:var(--dsw-alias-state-success-primary)}
.ogp-dotWarn{background:var(--dsw-alias-state-warn-primary,#d97706)}
.ogp-dotError{background:var(--dsw-alias-state-error-primary)}
.ogp-dotBlank{background:0 0;border:1px solid var(--dsw-alias-border-l3)}

/* The kebab: three dots from one element (the dot plus two box-shadow copies). */
.ogp-iconButton{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;padding:0;background:0 0;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ogp-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ogp-iconButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.ogp-kebab{width:3px;height:3px;border-radius:50%;background:currentColor;box-shadow:0 -5px 0 currentColor,0 5px 0 currentColor}

.ogp-menuRoot{position:relative;display:inline-flex;flex:none}
.ogp-menu{position:absolute;top:30px;left:0;z-index:6;min-width:184px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));flex-direction:column;display:flex}
.ogp-menuItem{box-sizing:border-box;text-align:left;width:100%;padding:7px 10px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.ogp-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ogp-menuItem:disabled{cursor:default;opacity:.4}
.ogp-menuItemDanger{color:var(--dsw-alias-state-error-primary)}
.ogp-menuItemDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.ogp-menuSep{display:block;height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2)}

.ogp-accountMeters{flex-wrap:wrap;gap:6px 20px;display:flex;padding-left:16px}
.ogp-miniMeter{align-items:center;gap:8px;display:inline-flex;font-size:12px;line-height:18px}
.ogp-miniMeterLabel{color:var(--dsw-alias-label-tertiary)}
.ogp-miniMeterTrack{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;width:64px;height:4px}
.ogp-miniMeterFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%}
.ogp-miniMeterFillWarn{background:var(--dsw-alias-state-error-primary)}
.ogp-miniMeterValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}

.ogp-accountDetails{container-type:inline-size;border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;display:flex;padding-top:12px}
.ogp-accountAlert{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.ogp-accountAlertTitle{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;font-weight:500;line-height:20px}
.ogp-accountAlertHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.ogp-accountMeta{align-items:center;gap:8px;display:flex;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ogp-windows{flex-direction:column;gap:14px;display:flex}
.ogp-window{flex-direction:column;gap:6px;display:flex}
.ogp-windowHead{align-items:baseline;gap:8px;display:flex}
.ogp-windowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;line-height:18px}
.ogp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ogp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}
.ogp-bar{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;height:6px}
.ogp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ogp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.ogp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}

.ogp-inlineForm,.ogp-confirmBar{flex-direction:column;gap:8px;display:flex;padding-left:16px}
.ogp-confirmBar{padding:12px 14px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;margin-left:16px}
.ogp-inlineActions{align-items:center;gap:8px;display:flex;flex-wrap:wrap}

.ogp-addButton{box-sizing:border-box;align-items:center;justify-content:center;gap:6px;display:flex;width:100%;height:40px;margin-top:8px;border:1px dashed var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.ogp-addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ogp-addButton:disabled{cursor:default;opacity:.4}
.ogp-addGlyph{position:relative;width:12px;height:12px}
.ogp-addGlyph::before,.ogp-addGlyph::after{content:'';position:absolute;background:currentColor;border-radius:1px}
.ogp-addGlyph::before{left:0;right:0;top:5.25px;height:1.5px}
.ogp-addGlyph::after{top:0;bottom:0;left:5.25px;width:1.5px}
.ogp-addPanel{flex-direction:column;gap:10px;display:flex;margin-top:8px;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.ogp-addPanel .ogp-inlineActions{flex-wrap:wrap}
.ogp-addPanel .ogp-input{flex:1 1 160px;width:auto}

.ogp-modelList{flex-direction:column;gap:2px;display:flex;max-height:300px;overflow:auto;padding:4px 0}
.ogp-modelRow{align-items:center;gap:8px;display:flex;font-size:13px;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-radius:8px;cursor:pointer}
.ogp-modelRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ogp-modelId{opacity:.65;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ogp-actions{align-items:center;gap:8px;display:flex;flex-wrap:wrap;padding-top:4px}

/* A group header's trailing controls share one vertically centred row: the
   refresh action and the timestamp it produced. */
.ogp-groupAction{align-items:center;gap:8px;display:inline-flex;flex-wrap:wrap}

/* The floating save bar: a centred capsule pinned to the bottom of the
   settings scrollport. The dock is a zero-height sticky strip at the end of the
   page, so the bar overlays the scrolling content instead of taking a row of
   its own; while shown, the section reserves room at its end so the last line
   can scroll clear. It stays mounted so it can animate out, and keeps showing
   its last message while it does. */
.ogp-sectionWithBar{padding-bottom:80px}
.ogp-saveBarDock{position:sticky;bottom:0;z-index:2;height:0;pointer-events:none}
.ogp-saveBar{--ogp-saveBar-tone:var(--dsw-alias-state-warn-primary,#d97706);position:absolute;left:50%;bottom:20px;box-sizing:border-box;width:max-content;max-width:calc(100% - 24px);align-items:center;gap:10px;display:flex;height:44px;padding:4px 4px 4px 16px;border:0;border-radius:22px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));opacity:0;visibility:hidden;transform:translate(-50%,12px);transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}
.ogp-saveBarShown{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .2s ease,transform .24s cubic-bezier(.2,.9,.3,1.1),visibility 0s}
.ogp-saveBar-error{--ogp-saveBar-tone:var(--dsw-alias-state-error-primary)}
.ogp-saveBar-success{--ogp-saveBar-tone:var(--dsw-alias-state-success-primary,#16a34a);padding-right:18px}
.ogp-saveBarIcon{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:16px;height:16px;color:var(--ogp-saveBar-tone)}
.ogp-saveBarPulse{width:8px;height:8px;border-radius:50%;background:var(--ogp-saveBar-tone)}
.ogp-saveBarText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.ogp-saveBar-error .ogp-saveBarText{color:var(--dsw-alias-state-error-primary)}
.ogp-saveBarActions{flex-shrink:0;align-items:center;gap:4px;display:flex;margin-left:8px}
.ogp-saveBarButton{box-sizing:border-box;height:36px;padding:0 16px;border:0;border-radius:18px;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.ogp-saveBarButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.ogp-saveBarButton:disabled{cursor:default;opacity:.4}
.ogp-saveBarGhost{background:0 0;color:var(--dsw-alias-label-primary)}
.ogp-saveBarGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ogp-saveBarPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.ogp-saveBarPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}

.ogp-notice{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.ogp-noticeWarn{border-color:var(--dsw-alias-state-warn-primary,#d97706)}
.ogp-noticeOk{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l3))}
.ogp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}

/* ------------------------------------------------- dashboard & sidebar */
.ogp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.ogp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.ogp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0}
.ogp-close span{font-size:16px;line-height:1}

.ogp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.ogp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ogp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ogp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.ogp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
.ogp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.ogp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.ogp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
/* Phrasing content only: this card renders inside the shell's own button, so
   the bar is a span — which makes display:block load-bearing. */
.ogp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.ogp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ogp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.ogp-footPct{flex:none;width:38px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.ogp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.ogp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ogp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ogp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}

/* The settings nav row: the shell hardcodes a gear for unknown section ids, so
   a one-line rule hides it for OUR row only (without :has() the row simply
   shows both icons). */
button:has(.dsh-ogp-nav-mark) > svg{display:none}

@media (prefers-reduced-motion:reduce){.ogp-chevron,.ogp-toggle::after,.ogp-barFill,.ogp-footFill{transition:none}}
`;

    // --------------------------------------------------------------- remote

    // Client-side Remote contribution. The result codecs are pass-through
    // parsers: the Host validates business results against its own zod schemas
    // before they cross the wire; this side only needs the descriptor shapes
    // to mount and call. Every codec must be strict and carry a create()
    // factory — the generated client typert registry rejects strict descriptors
    // without one.
    const passthrough = () => ({ parse(value) { return value; } });
    const strict = () => {
      const schema = passthrough();
      return { mode: 'strict', typeSymbol: 'json', schema, create: () => schema };
    };
    const DESCRIPTOR = (method, parameters) => ({
      id: `dsh-opencode-go-pool#opencodePool/${method}`,
      service: 'opencodePool',
      namespace: 'opencodePool',
      method,
      invocation: { kind: 'direct' },
      parameters: parameters.map(p => ({ name: p, wire: p, source: 'json', codec: strict() })),
      result: strict(),
    });

    const TYPERT_REMOTE = {
      package: 'dsh-opencode-go-pool',
      descriptors: [
        DESCRIPTOR('status', []),
        DESCRIPTOR('usage', []),
        DESCRIPTOR('setActive', ['id']),
        DESCRIPTOR('setDisabled', ['id', 'on']),
        DESCRIPTOR('clearInvalid', ['id']),
        DESCRIPTOR('putKeys', ['keys']),
        DESCRIPTOR('putKeySecret', ['id', 'secret']),
        DESCRIPTOR('putConfig', ['config']),
        DESCRIPTOR('takeOverState', []),
        DESCRIPTOR('refreshModels', []),
      ],
    };

    // -------------------------------------------------------------- helpers

    // The typert client Remote wraps every result in an `{ ok, value }`
    // envelope (ok:false carries `error.message`); unwrap or throw so the UI
    // only ever sees business values.
    function unwrapRemote(result) {
      if (result && result.ok === false) {
        throw new Error((result.error && result.error.message) || 'remote failed')
      }
      return result && result.value !== undefined ? result.value : result;
    }

    function messageOf(error) {
      return String((error && error.message) || error);
    }

    /** Merge a usage pass's rows into the last status payload, by key id. */
    function mergeUsage(data, rows) {
      if (!data || !Array.isArray(data.keys) || !Array.isArray(rows)) return data;
      const byId = new Map(rows.map(row => [row.id, row]));
      return {
        ...data,
        keys: data.keys.map(key => {
          const row = byId.get(key.id);
          if (row === undefined) return key;
          return {
            ...key,
            usage: row.usage,
            usageError: row.usageError,
            fetchedAt: row.fetchedAt,
            usagePending: row.usagePending,
            credentialSet: row.credentialSet,
          };
        }),
      };
    }

    /** A window's percent clamped for a bar fill (null = nothing reported). */
    function barPercent(windowData) {
      if (!windowData || typeof windowData.percent !== 'number') return 0;
      return Math.max(0, Math.min(100, windowData.percent));
    }

    /** The bar's tone: at/over 100% is a hard stop, 90%+ is a warning. */
    function barTone(windowData) {
      const percent = windowData && typeof windowData.percent === 'number' ? windowData.percent : null;
      if (percent === null) return 'flat';
      if (percent >= 100) return 'warn';
      if (percent >= 90) return 'alert';
      return 'flat';
    }

    function isWarnTone(tone) {
      return tone === 'warn' || tone === 'alert';
    }

    /** `resetsAt` as a compact countdown, or a locale date past a day out. */
    function formatReset(resetsAt, t, tick) {
      if (!resetsAt) return t('unknown');
      const target = new Date(resetsAt).getTime();
      if (Number.isNaN(target)) return resetsAt;
      const diff = target - tick;
      if (diff <= 0) return t('unknown');
      const totalMin = Math.floor(diff / 60000);
      if (totalMin < 60 * 24) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      }
      return new Date(resetsAt).toLocaleString();
    }

    function usageErrorText(code, t) {
      if (code === 'no-api-key') return t('noApiKey');
      if (code === 'unauthorized') return t('unauthorized');
      if (code === 'network') return t('network');
      if (code === 'bad-json') return t('badJson');
      if (code && code.startsWith('http-')) return t('httpError').replace('{status}', code.slice(5));
      return t('unknown');
    }

    function clockOf(iso) {
      if (!iso) return '';
      const at = new Date(iso);
      return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
    }

    /** Milliseconds as an editable seconds string (up to three decimals). */
    function msToSecondsText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      return String(Math.round((ms / 1000) * 1000) / 1000);
    }

    /** Parse an editable seconds string into the stored integer milliseconds. */
    function secondsTextToMs(text) {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') return { ok: false, reason: 'invalid' };
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { ok: false, reason: 'invalid' };
      const ms = Math.round(value * 1000);
      if (ms < 1000) return { ok: false, reason: 'tooSmall' };
      if (ms > MAX_TIMEOUT_MS) return { ok: false, reason: 'tooLarge' };
      return { ok: true, value: ms };
    }

    function isOverride(actual, fallback) {
      return typeof actual === 'number' && Number.isFinite(actual) && actual !== fallback;
    }

    // ------------------------------------------------- staged (saved) config
    //
    // Account edits commit the moment they are made, so nothing about a key
    // ever rides this. What the save bar stages is the *configuration*: the
    // rotation rules, the model selection, the sidebar toggle and the three
    // network settings. They are held as one snapshot of editable text, which
    // is what lets the bar answer "is anything unsaved?" and "what exactly
    // changed?" without each section knowing about the others.

    /** The staged shape of a host status payload. */
    function stagedConfig(data, available) {
      return {
        preempt: String(data.preemptAtPercent ?? 100),
        consec: String(data.switchAfterConsecutiveFailures ?? 0),
        request: msToSecondsText(data.requestTimeoutMs),
        stream: msToSecondsText(data.streamIdleTimeoutMs),
        retries: String(data.transportMaxRetries ?? 5),
        mode: data.modelMode === 'custom' ? 'custom' : 'all',
        ids: available.filter(model => model.enabled).map(model => model.id),
        showSidebarQuota: data.showSidebarQuota === true,
      };
    }

    /** The parsed, validated reading of one staged snapshot. */
    function readStaged(staged) {
      const preempt = Number(staged.preempt);
      const consec = Number(staged.consec);
      const retries = Number(staged.retries);
      return {
        preempt: { ok: Number.isFinite(preempt) && preempt >= 0 && preempt <= 100, value: preempt },
        consec: { ok: Number.isFinite(consec) && consec >= 0 && consec <= 20, value: consec },
        request: secondsTextToMs(staged.request),
        stream: secondsTextToMs(staged.stream),
        retries: { ok: Number.isInteger(retries) && retries >= 0 && retries <= 50, value: retries },
        models: { ok: staged.mode === 'all' || staged.ids.length > 0 },
      };
    }

    function stagedValid(reading) {
      return reading.preempt.ok && reading.consec.ok && reading.request.ok
        && reading.stream.ok && reading.retries.ok && reading.models.ok;
    }

    function sameIds(left, right) {
      if (left.length !== right.length) return false;
      const a = [...left].sort();
      const b = [...right].sort();
      return a.every((id, index) => id === b[index]);
    }

    /**
     * The putConfig patch for exactly what moved.
     * @returns the patch, or null when the draft matches the host.
     */
    function stagedPatch(current, baseline, reading) {
      const patch = {};
      if (reading.preempt.value !== Number(baseline.preempt)) patch.preemptAtPercent = reading.preempt.value;
      if (reading.consec.value !== Number(baseline.consec)) patch.switchAfterConsecutiveFailures = reading.consec.value;
      if (reading.request.value !== Number(secondsTextToMs(baseline.request).value)) patch.requestTimeoutMs = reading.request.value;
      if (reading.stream.value !== Number(secondsTextToMs(baseline.stream).value)) patch.streamIdleTimeoutMs = reading.stream.value;
      if (reading.retries.value !== Number(baseline.retries)) patch.transportMaxRetries = reading.retries.value;
      if (current.showSidebarQuota !== baseline.showSidebarQuota) patch.showSidebarQuota = current.showSidebarQuota;
      if (current.mode !== baseline.mode || !sameIds(current.ids, baseline.ids)) {
        patch.modelMode = current.mode;
        patch.models = current.mode === 'all' ? [] : current.ids;
      }
      return Object.keys(patch).length === 0 ? null : patch;
    }

    /** The tone a takeover state reads as: only the served route is green. */
    function takeoverBadge(takeover, t) {
      if (takeover === 'serving') return { cls: 'ogp-badge ogp-badgeOk', text: t('takeoverBadgeServing') };
      if (takeover === 'own-route') return { cls: 'ogp-badge ogp-badgeWarn', text: t('takeoverBadgeOwn') };
      return { cls: 'ogp-badge ogp-badgeWarn', text: t('takeoverBadgeWaiting') };
    }

    // ------------------------------------------------------------- the store

    /**
     * One data layer for every surface.
     *
     * The load is deliberately two-phase. `status()` is a pure in-memory read on
     * the host, so it answers in milliseconds and the page paints at once; the
     * per-key usage endpoint (the slow, network-bound part) is fetched by
     * `usage()` and merged into the rows when it lands. That split is what
     * removes the permanent "查询中…".
     */
    function createPoolStore(api) {
      let state = {
        data: null,
        error: null,
        failures: 0,
        loading: false,
        busy: null,
        notice: null,
        loadedAt: null,
        usageAt: null,
        pollMs: DEFAULT_POLL_MS,
      };
      const listeners = new Set();
      let timer = null;
      let refs = 0;
      let probe = null;
      let usageSeq = 0;

      const get = () => state;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      };
      const set = (patch) => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
      };

      async function remote() {
        const value = await api();
        if (!value) throw new Error('the opencodePool remote is not mounted');
        return value;
      }

      /** Reload the pool state. Never waits on (or triggers) a usage query. */
      async function load(options) {
        const withUsage = options?.usage !== false;
        set({ loading: true });
        try {
          const rows = unwrapRemote(await (await remote()).status());
          const pollMs = typeof rows.usageRefreshMs === 'number' && rows.usageRefreshMs > 0
            ? rows.usageRefreshMs
            : DEFAULT_POLL_MS;
          set({ data: rows, error: null, failures: 0, loadedAt: new Date(), loading: false, pollMs });
          if (withUsage) void loadUsage();
          retime();
        } catch (error) {
          set({ error: messageOf(error), failures: state.failures + 1, loading: false });
          retime();
        }
      }

      /** The network half: one pass over every key, merged into the rows. */
      async function loadUsage() {
        const seq = ++usageSeq;
        try {
          const handle = await remote();
          // Version skew is real — a browser tab can hold this bundle across a
          // Host upgrade, and the HMR swap lands the client half first. A Host
          // that predates the split serves no `usage` endpoint, so the page
          // keeps its state rows and simply never fills the numbers, instead of
          // failing the surface.
          if (typeof handle.usage !== 'function') return;
          const result = unwrapRemote(await handle.usage());
          if (seq !== usageSeq) return;
          set({ data: mergeUsage(state.data, result.keys), usageAt: result.fetchedAt, error: null, failures: 0 });
        } catch {
          // Per-key failures already ride the rows; a failure of the pass
          // itself is not worth a banner — the next poll retries it.
        }
      }

      function stopTimer() {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }

      /** (Re)arm the poll. Paused after three consecutive failures. */
      function retime() {
        stopTimer();
        if (refs === 0 || state.failures >= 3) return;
        timer = setInterval(() => { void load(); }, state.pollMs);
      }

      /**
       * Hold the poll open while a surface is mounted. The first holder starts
       * the load; `usage: false` keeps the pass status-only (the sidebar card's
       * probe for its own visibility flag).
       */
      function retain(options) {
        const withUsage = options?.usage !== false;
        refs += 1;
        if (refs === 1) void load({ usage: withUsage });
        retime();
        return () => {
          refs -= 1;
          if (refs <= 0) {
            refs = 0;
            stopTimer();
          } else {
            retime();
          }
        };
      }

      /** A one-shot status-only read, used before a surface knows its own gate. */
      function probeOnce() {
        if (state.data !== null || probe !== null) return probe ?? Promise.resolve();
        probe = load({ usage: false }).finally(() => { probe = null; });
        return probe;
      }

      async function run(fn, confirmText) {
        if (confirmText && typeof window !== 'undefined' && typeof window.confirm === 'function'
            && !window.confirm(confirmText)) {
          return false;
        }
        set({ busy: 'busy', notice: null });
        try {
          unwrapRemote(await fn(await remote()));
          await load();
          return true;
        } catch (error) {
          set({ notice: { ok: false, code: 'actionFailed', detail: messageOf(error) } });
          return false;
        } finally {
          set({ busy: null });
        }
      }

      return {
        get,
        subscribe,
        retain,
        probeOnce,
        refresh: () => load(),
        run,
        setNotice: (notice) => set({ notice }),
        clearNotice: () => set({ notice: null }),
        dispose: () => { stopTimer(); listeners.clear(); },
      };
    }

    // ----------------------------------------------------------- primitives

    /**
     * The nav-row mark: the same geometry as the shell's own IconSparkle16, so
     * the sidebar entry sits in the same icon language as its siblings (every
     * other row carries one).
     *
     * It doubles as the ANCHOR for the stylesheet's `:has()` rule: the shell
     * hardcodes a gear for any section id it does not know and renders it as a
     * direct child of the row button, so this element is what identifies OUR row
     * and lets that rule hide the gear instead of showing two icons.
     */
    function SparkleNavMark(props) {
      const { className } = props;
      return React.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        className, 'aria-hidden': 'true',
        style: { display: 'inline-block', flex: 'none', marginRight: 8, verticalAlign: '-3px' },
      },
        React.createElement('path', { d: 'M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z', fill: 'currentColor' }),
        React.createElement('path', { d: 'M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z', fill: 'currentColor' }),
        React.createElement('path', { d: 'M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z', fill: 'currentColor' }),
      );
    }

    /**
     * The quota ring: a faint track plus an arc whose sweep is consumption,
     * drawn from 12 o'clock. Circumference 2πr = 45.55 at r = 7.25.
     */
    function Ring(props) {
      const { percent, warn, size } = props;
      const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
      const circumference = 45.55;
      const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1000) / 1000;
      return React.createElement('span', { className: 'ogp-glyph', 'aria-hidden': 'true' },
        React.createElement('svg', { viewBox: '0 0 20 20', width: size, height: size, focusable: 'false' },
          React.createElement('circle', { cx: 10, cy: 10, r: 7.25, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.4 }),
          React.createElement('circle', {
            cx: 10, cy: 10, r: 7.25, fill: 'none',
            stroke: warn ? 'var(--dsw-alias-state-error-primary)' : 'currentColor',
            strokeWidth: 2.5, strokeLinecap: 'round',
            strokeDasharray: String(circumference), strokeDashoffset: String(dashoffset),
            transform: 'rotate(-90 10 10)',
          }),
        ),
      );
    }

    function Button(props) {
      const { variant, className, children, ...rest } = props;
      const styles = ['ogp-button'];
      if (variant === 'primary') styles.push('ogp-buttonPrimary');
      if (variant === 'danger') styles.push('ogp-buttonDanger');
      if (className) styles.push(className);
      return React.createElement('button', { type: 'button', className: styles.join(' '), ...rest }, children);
    }

    function LinkButton(props) {
      const { className, children, ...rest } = props;
      return React.createElement('button', {
        type: 'button',
        className: className ? `ogp-linkButton ${className}` : 'ogp-linkButton',
        ...rest,
      }, children);
    }

    /** A titled group of rows; the hairline belongs to the group, not the rows. */
    function SettingsGroup(props) {
      const { title, action, description, divided, children } = props;
      return React.createElement('section', {
        className: divided ? 'ogp-group ogp-groupDivided' : 'ogp-group',
        'aria-label': title,
      },
        React.createElement('div', { className: 'ogp-groupHead' },
          React.createElement('h3', { className: 'ogp-groupTitle' }, title),
          action ?? null,
        ),
        description !== undefined && description !== null && description !== ''
          ? React.createElement('p', { className: 'ogp-groupDesc' }, description)
          : null,
        React.createElement('div', { className: 'ogp-rows' }, children),
      );
    }

    /** One settings row: title/description left, control right. */
    function SettingRow(props) {
      const { title, description, error, control, htmlFor, tag } = props;
      return React.createElement('div', { className: 'ogp-row' },
        React.createElement('div', { className: 'ogp-rowText' },
          React.createElement('div', { className: 'ogp-rowTitleLine' },
            htmlFor !== undefined
              ? React.createElement('label', { className: 'ogp-rowTitle', htmlFor }, title)
              : React.createElement('span', { className: 'ogp-rowTitle' }, title),
            tag ?? null,
          ),
          error !== undefined && error !== null
            ? React.createElement('p', { className: 'ogp-rowError' }, error)
            : (description ? React.createElement('div', { className: 'ogp-rowDesc' }, description) : null),
        ),
        control !== undefined ? React.createElement('div', { className: 'ogp-rowControl' }, control) : null,
      );
    }

    /** A dropdown menu anchored on a kebab button. */
    function KebabMenu(props) {
      const { items, onSelect, label } = props;
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);
      if (items.length === 0) return null;
      return React.createElement('span', { className: 'ogp-menuRoot', ref: rootRef },
        React.createElement('button', {
          type: 'button',
          className: 'ogp-iconButton',
          'aria-label': label,
          title: label,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        }, React.createElement('span', { className: 'ogp-kebab', 'aria-hidden': 'true' })),
        open
          ? React.createElement('span', { className: 'ogp-menu', role: 'menu' },
              items.map(item => (item.type === 'separator'
                ? React.createElement('span', { key: item.id, className: 'ogp-menuSep', role: 'separator' })
                : React.createElement('button', {
                    key: item.id,
                    type: 'button',
                    role: 'menuitem',
                    className: item.danger ? 'ogp-menuItem ogp-menuItemDanger' : 'ogp-menuItem',
                    disabled: item.disabled === true,
                    onClick: () => {
                      setOpen(false);
                      onSelect(item.id);
                    },
                  }, item.label))),
            )
          : null,
      );
    }

    /** One labelled quota bar with its reset line. */
    function UsageWindow(props) {
      const { label, windowData, t, tick } = props;
      const percent = windowData && typeof windowData.percent === 'number' ? windowData.percent : null;
      const tone = barTone(windowData);
      const shown = percent === null ? t('unknown') : `${percent}%`;
      const left = percent === null ? t('unknown') : `${Math.max(0, 100 - percent)}%`;
      return React.createElement('div', { className: 'ogp-window' },
        React.createElement('div', { className: 'ogp-windowHead' },
          React.createElement('span', { className: 'ogp-windowLabel' }, label),
          React.createElement('span', { className: 'ogp-windowValue' },
            `${t('used')} ${shown} · ${t('left')} ${left}`),
          React.createElement('span', { className: 'ogp-windowPct' }, shown),
        ),
        React.createElement('div', {
          className: 'ogp-bar', role: 'progressbar', 'aria-label': label,
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(barPercent(windowData)),
        },
          React.createElement('div', {
            className: isWarnTone(tone) ? 'ogp-barFill ogp-barFillWarn' : 'ogp-barFill',
            style: { width: `${barPercent(windowData)}%` },
          }),
        ),
        React.createElement('p', { className: 'ogp-windowReset' },
          `${t('resets')}: ${formatReset(windowData && windowData.resetsAt, t, tick)}`),
      );
    }

    /** The compact one-line meter the collapsed account card shows. */
    function MiniMeter(props) {
      const { label, windowData, t } = props;
      const percent = windowData && typeof windowData.percent === 'number' ? windowData.percent : null;
      const tone = barTone(windowData);
      return React.createElement('span', {
        className: 'ogp-miniMeter',
        title: windowData && windowData.resetsAt ? formatReset(windowData.resetsAt, t, Date.now()) : undefined,
      },
        React.createElement('span', { className: 'ogp-miniMeterLabel' }, label),
        React.createElement('span', { className: 'ogp-miniMeterTrack', 'aria-hidden': 'true' },
          React.createElement('span', {
            className: isWarnTone(tone) ? 'ogp-miniMeterFill ogp-miniMeterFillWarn' : 'ogp-miniMeterFill',
            style: { width: `${barPercent(windowData)}%` },
          }),
        ),
        React.createElement('span', { className: 'ogp-miniMeterValue' },
          percent === null ? '—' : `${percent}%`),
      );
    }

    /** A single-input inline form (paste a key, rename) with apply/cancel. */
    function InlineInput(props) {
      const { label, secret, initial, placeholder, confirmLabel, disabled, t, onSubmit, onCancel } = props;
      const [value, setValue] = React.useState(initial ?? '');
      const [visible, setVisible] = React.useState(false);
      const ready = value.trim() !== '';
      return React.createElement('form', {
        className: 'ogp-inlineForm',
        onSubmit: (event) => {
          event.preventDefault();
          if (ready && !disabled) onSubmit(value);
        },
      },
        React.createElement('input', {
          className: 'ogp-input',
          style: { width: '100%' },
          type: secret && !visible ? 'password' : 'text',
          'aria-label': label,
          autoComplete: 'new-password',
          spellCheck: false,
          placeholder,
          value,
          disabled,
          onChange: event => setValue(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Escape') onCancel(); },
        }),
        React.createElement('div', { className: 'ogp-inlineActions' },
          secret && value !== ''
            ? React.createElement(LinkButton, { onClick: () => setVisible(shown => !shown) },
                visible ? t('hide') : t('show'))
            : null,
          React.createElement('span', { className: 'ogp-spacer' }),
          React.createElement(Button, { onClick: onCancel }, t('cancel')),
          React.createElement(Button, { variant: 'primary', type: 'submit', disabled: !ready || disabled }, confirmLabel),
        ),
      );
    }

    /** A destructive confirmation bar shown in place of the card's body. */
    function ConfirmBar(props) {
      const { text, confirmLabel, disabled, t, onConfirm, onCancel } = props;
      return React.createElement('div', { className: 'ogp-confirmBar', role: 'alertdialog', 'aria-label': text },
        React.createElement('p', { className: 'ogp-accountAlertTitle' }, text),
        React.createElement('div', { className: 'ogp-inlineActions' },
          React.createElement('span', { className: 'ogp-spacer' }),
          React.createElement(Button, { onClick: onCancel }, t('cancel')),
          React.createElement(Button, { variant: 'danger', disabled, onClick: onConfirm }, confirmLabel),
        ),
      );
    }

    /** The row's status dot. Blank on a standby account: only a verdict shows. */
    function statusDotClass(item) {
      if (item.state === 'invalid') return 'ogp-dot ogp-dotError';
      if (item.state === 'exhausted') return 'ogp-dot ogp-dotWarn';
      if (item.state === 'disabled') return 'ogp-dot ogp-dotBlank';
      if (item.active) return 'ogp-dot ogp-dotOk';
      return 'ogp-dot ogp-dotBlank';
    }

    /** The one badge the collapsed head carries, or null when there is none. */
    function stateBadge(item, t, multi) {
      if (item.state === 'exhausted') return { cls: 'ogp-badge ogp-badgeWarn', text: t('exhaustedBadge') };
      if (item.state === 'invalid') return { cls: 'ogp-badge ogp-badgeError', text: t('invalidBadge') };
      if (item.state === 'disabled') return { cls: 'ogp-badgeMuted', text: t('disabledBadge') };
      if (item.active && multi) return { cls: 'ogp-badge', text: t('activeBadge') };
      return null;
    }

    // ------------------------------------------------------------- account

    /**
     * One account, as a slim row card.
     *
     * Collapsed it is a single line plus the quota meters; everything else —
     * the full windows, the fetch time, the last failure — lives behind the
     * disclosure, and every mutation lives in the kebab menu at the card's
     * top-left (edit the credential, rename, pin, disable, clear the invalid
     * mark, remove). Selecting "edit credential" turns the card into the same
     * inline form, which is the only mode that ever shows a secret field.
     */
    function AccountItem(props) {
      const { item, t, tick, busy, multi, data, actions } = props;
      const [expanded, setExpanded] = React.useState(false);
      const [mode, setMode] = React.useState(null);
      const usage = item.usage || {};
      const locked = busy !== null;

      const menuItems = [];
      if (item.state === 'healthy' && !item.active) {
        menuItems.push({ id: 'pin', label: t('accountActionPin') });
      }
      if (menuItems.length > 0) menuItems.push({ type: 'separator', id: 'sep-pin' });
      menuItems.push({ id: 'key', label: t('accountActionKey') });
      menuItems.push({ id: 'rename', label: t('accountActionRename') });
      menuItems.push(item.state === 'disabled'
        ? { id: 'toggle', label: t('enable') }
        : { id: 'toggle', label: t('disable') });
      if (item.state === 'invalid') menuItems.push({ id: 'clear', label: t('clearInvalid') });
      menuItems.push({ type: 'separator', id: 'sep-danger' });
      menuItems.push({ id: 'remove', label: t('accountActionRemove'), danger: true });

      const onMenu = (id) => {
        if (id === 'pin') actions.setActive(item.id);
        else if (id === 'toggle') actions.setDisabled(item.id, item.state !== 'disabled');
        else if (id === 'clear') actions.clearInvalid(item.id);
        else if (id === 'key' || id === 'rename' || id === 'remove') setMode(id);
      };

      const badge = stateBadge(item, t, multi);
      const hasWindows = item.usage !== null && item.usage !== undefined;

      return React.createElement('div', {
        className: item.active ? 'ogp-accountItem ogp-accountItemActive' : 'ogp-accountItem',
      },
        React.createElement('div', { className: 'ogp-accountHead' },
          React.createElement(KebabMenu, {
            items: menuItems,
            onSelect: onMenu,
            label: `${item.label} — ${t('accountActions')}`,
          }),
          React.createElement('button', {
            type: 'button',
            className: 'ogp-accountToggle',
            'aria-expanded': expanded,
            onClick: () => setExpanded(value => !value),
          },
            React.createElement('span', { className: statusDotClass(item), 'aria-hidden': 'true' }),
            React.createElement('span', { className: 'ogp-accountName' }, item.label),
            badge !== null ? React.createElement('span', { className: badge.cls }, badge.text) : null,
            !item.credentialSet && !item.usagePending
              ? React.createElement('span', { className: 'ogp-badgeMuted' }, t('apiKeyUnset'))
              : null,
            React.createElement('span', { className: 'ogp-spacer' }),
            React.createElement('span', {
              className: expanded ? 'ogp-chevron ogp-chevronUp' : 'ogp-chevron',
              'aria-hidden': 'true',
            }),
          ),
        ),

        hasWindows
          ? React.createElement('div', { className: 'ogp-accountMeters' },
              React.createElement(MiniMeter, { label: t('rolling'), windowData: usage.rolling, t }),
              React.createElement(MiniMeter, { label: t('weekly'), windowData: usage.weekly, t }),
              React.createElement(MiniMeter, { label: t('monthly'), windowData: usage.monthly, t }),
            )
          : (item.usagePending && mode === null
              ? React.createElement('p', { className: 'ogp-hint', style: { paddingLeft: 16 } }, t('usagePending'))
              : null),

        item.usageError !== null && item.usageError !== undefined
          ? React.createElement('p', { className: 'ogp-error', style: { paddingLeft: 16 } },
              usageErrorText(item.usageError, t))
          : null,

        mode === 'key'
          ? React.createElement(InlineInput, {
              label: t('accountKeyPlaceholder'),
              secret: true,
              placeholder: t('accountKeyPlaceholder'),
              confirmLabel: t('accountApply'),
              disabled: locked,
              t,
              onCancel: () => setMode(null),
              onSubmit: (value) => { void actions.setKey(item.id, value).then(ok => { if (ok) setMode(null); }); },
            })
          : null,
        mode === 'rename'
          ? React.createElement(InlineInput, {
              label: t('accountActionRename'),
              initial: item.label,
              confirmLabel: t('accountApply'),
              disabled: locked,
              t,
              onCancel: () => setMode(null),
              onSubmit: (value) => { void actions.rename(item.id, value).then(ok => { if (ok) setMode(null); }); },
            })
          : null,
        mode === 'remove'
          ? React.createElement(ConfirmBar, {
              text: t('accountRemoveConfirm').replace('{name}', item.label),
              confirmLabel: t('accountConfirmRemove'),
              disabled: locked,
              t,
              onCancel: () => setMode(null),
              onConfirm: () => { void actions.remove(item.id).then(ok => { if (ok) setMode(null); }); },
            })
          : null,

        expanded
          ? React.createElement('div', { className: 'ogp-accountDetails' },
              hasWindows
                ? React.createElement('div', { className: 'ogp-windows' },
                    React.createElement(UsageWindow, { label: t('rolling'), windowData: usage.rolling, t, tick }),
                    React.createElement(UsageWindow, { label: t('weekly'), windowData: usage.weekly, t, tick }),
                    React.createElement(UsageWindow, { label: t('monthly'), windowData: usage.monthly, t, tick }),
                  )
                : React.createElement('p', { className: 'ogp-hint' }, t('usagePending')),
              React.createElement('div', { className: 'ogp-accountMeta' },
                React.createElement('span', null, `${t('credentialRef')}: ${item.apiKeyEnv}`),
                item.fetchedAt
                  ? React.createElement('span', null, `${t('usageUpdated')} ${clockOf(item.fetchedAt)}`)
                  : null,
              ),
              item.lastFailure
                ? React.createElement('p', { className: 'ogp-hint' },
                    `${t('lastFailure')}: ${item.lastFailure.code} · ${item.lastFailure.message}`)
                : null,
            )
          : null,
      );
    }

    // ------------------------------------------------------- page sections

    /** One text/number field row with its own validation message. */
    function NumberField(props) {
      const { id, label, hint, value, unit, invalidReason, disabled, t, onChange, onReset, overridden } = props;
      const error = invalidReason === undefined ? undefined : invalidText(invalidReason, t);
      return React.createElement(SettingRow, {
        title: label,
        htmlFor: id,
        description: hint,
        error,
        tag: overridden ? React.createElement('span', { className: 'ogp-badge' }, t('overridden')) : null,
        control: React.createElement(React.Fragment, null,
          overridden
            ? React.createElement(LinkButton, { disabled, onClick: onReset, title: t('reset') }, t('reset'))
            : null,
          React.createElement('input', {
            id,
            className: error === undefined ? 'ogp-input ogp-inputNarrow' : 'ogp-input ogp-inputNarrow ogp-inputInvalid',
            type: 'text',
            inputMode: 'decimal',
            'aria-invalid': error === undefined ? undefined : true,
            value,
            disabled,
            onChange: event => onChange(event.target.value),
          }),
          unit !== undefined ? React.createElement('span', { className: 'ogp-meta' }, unit) : null,
        ),
      });
    }

    function invalidText(reason, t) {
      if (reason === 'duration') return t('durationInvalid');
      if (reason === 'tooSmall') return t('durationTooSmall');
      if (reason === 'tooLarge') return t('durationTooLarge');
      if (reason === 'invalid') return t('invalidNumber');
      return t('invalidNumber');
    }

    /** The text one store notice renders as. */
    function noticeText(notice, t) {
      if (notice.ok) {
        if (notice.code === 'modelFetched') return notice.detail ?? t('saved');
        return t('saved');
      }
      const head = notice.code === 'saveFailed' ? t('saveFailed')
        : notice.code === 'modelFetchFailed' ? t('modelFetchFailed')
          : t('actionFailed');
      return notice.detail ? `${head}: ${notice.detail}` : head;
    }

    /**
     * Accounts: the cards, the add form, and the rotation rules.
     *
     * Every key operation on this page commits the moment it is made — nothing
     * about an account waits for the save bar. Only the rotation RULES are
     * staged, because they are configuration like everything below them.
     */
    function AccountsGroup(props) {
      const { t, data, busy, current, reading, onEdit, actions, loadedAt, refreshing } = props;
      const keys = Array.isArray(data.keys) ? data.keys : [];
      const multi = keys.length > 1;
      const pinned = keys.find(key => key.active);
      const [adding, setAdding] = React.useState(false);
      return React.createElement(SettingsGroup, {
        title: t('accountsTitle'),
        description: multi ? t('accountsRotationHint') : t('accountsHint'),
        // The refresh action and the timestamp it produced share one vertically
        // centred row, so the freshness of the numbers is readable in place.
        action: React.createElement('span', { className: 'ogp-groupAction' },
          React.createElement(LinkButton, {
            disabled: busy !== null || refreshing,
            onClick: actions.refresh,
          }, refreshing ? t('refreshing') : t('refresh')),
          loadedAt
            ? React.createElement('span', { className: 'ogp-meta' },
                `${t('updatedAt')} ${loadedAt.toLocaleTimeString()}`)
            : null,
        ),
      },
        multi
          ? React.createElement('p', { className: 'ogp-meta' },
              pinned ? t('accountModePinned').replace('{name}', pinned.label) : t('accountModeAuto'))
          : null,

        keys.length === 0
          ? React.createElement('div', { className: 'ogp-notice' },
              React.createElement('p', { className: 'ogp-noticeTitle' }, t('noKeysTitle')),
              React.createElement('p', { className: 'ogp-hint' }, t('noKeysHint')),
            )
          : React.createElement('div', { className: 'ogp-accountList' },
              keys.map(item => React.createElement(AccountItem, {
                key: item.id, item, t, tick: actions.tick, busy, multi, data, actions,
              })),
            ),

        adding
          ? React.createElement(AddAccountPanel, {
              t,
              disabled: busy !== null,
              onCancel: () => setAdding(false),
              onSubmit: (name, secret) => { void actions.addAccount(name, secret).then(ok => { if (ok) setAdding(false); }); },
            })
          : React.createElement('button', {
              type: 'button',
              className: 'ogp-addButton',
              disabled: busy !== null,
              onClick: () => setAdding(true),
            },
              React.createElement('span', { className: 'ogp-addGlyph', 'aria-hidden': 'true' }),
              t('accountAdd'),
            ),

        keys.length > 0
          ? React.createElement('div', { style: { marginTop: 20 } },
              React.createElement('h4', { className: 'ogp-groupTitle' }, t('strategyTitle')),
              React.createElement('p', { className: 'ogp-groupDesc' }, t('strategyHint')),
              React.createElement(SettingRow, {
                title: t('preemptLabel'),
                error: reading.preempt.ok ? undefined : t('invalidNumber'),
                control: React.createElement('input', {
                  className: reading.preempt.ok ? 'ogp-input ogp-inputNarrow' : 'ogp-input ogp-inputNarrow ogp-inputInvalid',
                  type: 'text',
                  inputMode: 'numeric',
                  value: current.preempt,
                  disabled: busy !== null,
                  onChange: event => onEdit('preempt', event.target.value),
                }),
              }),
              React.createElement(SettingRow, {
                title: t('consecLabel'),
                error: reading.consec.ok ? undefined : t('invalidNumber'),
                control: React.createElement('input', {
                  className: reading.consec.ok ? 'ogp-input ogp-inputNarrow' : 'ogp-input ogp-inputNarrow ogp-inputInvalid',
                  type: 'text',
                  inputMode: 'numeric',
                  value: current.consec,
                  disabled: busy !== null,
                  onChange: event => onEdit('consec', event.target.value),
                }),
              }),
            )
          : null,

        data.lastSwitch
          ? React.createElement('p', { className: 'ogp-hint', style: { marginTop: 12 } },
              `${t('lastSwitch')}: ${data.lastSwitch.from ?? '—'} → ${data.lastSwitch.to ?? '—'}`
              + ` (${switchReasonText(data.lastSwitch.reason, t)})`
              + ` @ ${new Date(data.lastSwitch.at).toLocaleString()}`)
          : null,
      );
    }

    /**
     * The add-account form: a display name and the key, both asked for before
     * anything is written. The key goes straight through putKeySecret, so it
     * never reaches a settings document.
     */
    function AddAccountPanel(props) {
      const { t, disabled, onSubmit, onCancel } = props;
      const [name, setName] = React.useState('');
      const [secret, setSecret] = React.useState('');
      const [visible, setVisible] = React.useState(false);
      const ready = name.trim() !== '' && secret.trim() !== '';
      return React.createElement('form', {
        className: 'ogp-addPanel',
        onSubmit: (event) => {
          event.preventDefault();
          if (ready && !disabled) onSubmit(name.trim(), secret.trim());
        },
      },
        React.createElement('span', { className: 'ogp-groupTitle' }, t('accountAdd')),
        React.createElement('div', { className: 'ogp-inlineActions' },
          React.createElement('input', {
            className: 'ogp-input',
            type: 'text',
            'aria-label': t('accountNamePlaceholder'),
            placeholder: t('accountNamePlaceholder'),
            value: name,
            disabled,
            onChange: event => setName(event.target.value),
          }),
          React.createElement('input', {
            className: 'ogp-input',
            style: { flex: '1 1 220px' },
            type: visible ? 'text' : 'password',
            'aria-label': t('accountKeyPlaceholder'),
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: t('accountKeyPlaceholder'),
            value: secret,
            disabled,
            onChange: event => setSecret(event.target.value),
          }),
          secret !== ''
            ? React.createElement(LinkButton, { onClick: () => setVisible(shown => !shown) },
                visible ? t('hide') : t('show'))
            : null,
        ),
        React.createElement('div', { className: 'ogp-inlineActions' },
          React.createElement('span', { className: 'ogp-spacer' }),
          React.createElement(Button, { onClick: onCancel }, t('cancel')),
          React.createElement(Button, { variant: 'primary', type: 'submit', disabled: !ready || disabled },
            t('accountApply')),
        ),
      );
    }

    /** Models: the range switch, the fetch action, the checkbox allowlist. */
    function ModelsGroup(props) {
      const { t, data, busy, current, onSetMode, onToggleModel, onFetch, fetching } = props;
      const [open, setOpen] = React.useState(false);
      const available = Array.isArray(data.availableModels) ? data.availableModels : [];
      const enabledCount = available.filter(model => current.mode === 'all' || current.ids.includes(model.id)).length;
      const dynamicCount = available.filter(model => model.dynamic).length;
      const counts = dynamicCount > 0
        ? `${t('modelCount').replace('{n}', String(enabledCount))} · ${t('dynamicTag')}${String(dynamicCount)}`
        : t('modelCount').replace('{n}', String(enabledCount));

      return React.createElement(SettingsGroup, {
        title: t('modelsTitle'),
        description: t('modelsHint'),
        divided: true,
        action: React.createElement(LinkButton, {
          disabled: fetching || busy !== null,
          onClick: onFetch,
        }, fetching ? t('modelFetching') : t('modelFetch')),
      },
        React.createElement(SettingRow, {
          title: t('modelsRange'),
          description: t('modelsRangeHint'),
          error: available.length === 0
            ? t('modelUnavailable')
            : (current.mode === 'custom' && current.ids.length === 0 ? t('modelNone') : undefined),
          control: React.createElement(React.Fragment, null,
            React.createElement('span', { className: 'ogp-badge' }, counts),
            React.createElement('label', { className: 'ogp-checkRow' },
              React.createElement('input', {
                className: 'ogp-check',
                type: 'checkbox',
                checked: current.mode === 'all',
                disabled: busy !== null,
                onChange: event => onSetMode(event.target.checked ? 'all' : 'custom'),
              }),
              React.createElement('span', null, t('allModels')),
            ),
            available.length > 0
              ? React.createElement(LinkButton, { onClick: () => setOpen(prev => !prev) },
                  open ? t('modelCollapse') : t('modelExpand'))
              : null,
          ),
        }),
        React.createElement('p', { className: 'ogp-hint' }, t('modelFetchHint')),
        open && available.length > 0
          ? React.createElement('div', { className: 'ogp-modelList' },
              available.map(model => React.createElement('label', {
                key: model.id,
                className: 'ogp-modelRow',
              },
                React.createElement('input', {
                  className: 'ogp-check',
                  type: 'checkbox',
                  checked: current.mode === 'all' || current.ids.includes(model.id),
                  disabled: busy !== null || current.mode === 'all',
                  onChange: () => onToggleModel(model.id),
                }),
                React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, model.name),
                React.createElement('span', { className: 'ogp-modelId' }, model.id),
                model.dynamic ? React.createElement('span', { className: 'ogp-badgeMuted' }, t('dynamicTag')) : null,
              )),
            )
          : null,
      );
    }

    /** Integrations & display: surfaces outside chat that reuse this plugin. */
    function IntegrationsGroup(props) {
      const { t, busy, current, onEdit } = props;
      return React.createElement(SettingsGroup, {
        title: t('integrationsTitle'),
        description: t('integrationsHint'),
        divided: true,
      },
        React.createElement(SettingRow, {
          title: t('showSidebarQuota'),
          htmlFor: 'ogp-show-sidebar-quota',
          description: t('showSidebarQuotaHint'),
          control: React.createElement('input', {
            id: 'ogp-show-sidebar-quota',
            className: 'ogp-toggle',
            type: 'checkbox',
            role: 'switch',
            checked: current.showSidebarQuota,
            disabled: busy !== null,
            onChange: event => onEdit('showSidebarQuota', event.target.checked),
          }),
        }),
      );
    }

    /**
     * The collapsed Advanced disclosure: the two network timeouts and the
     * transport retry budget. The values are staged; the save bar commits them
     * through putConfig, which writes the plugin's own Config through the
     * settings service — so the very next request uses them.
     */
    function AdvancedGroup(props) {
      const { t, busy, current, reading, onEdit } = props;
      const [open, setOpen] = React.useState(false);
      const invalid = !reading.request.ok || !reading.stream.ok || !reading.retries.ok;
      // "Customized" is judged against the DRAFT, so the tag and the per-field
      // reset link appear the moment a value leaves its default — not only once
      // the save bar has committed it.
      const overriddenFields = {
        request: !reading.request.ok || reading.request.value !== 300000,
        stream: !reading.stream.ok || reading.stream.value !== 300000,
        retries: !reading.retries.ok || reading.retries.value !== 5,
      };
      const overridden = Object.values(overriddenFields).filter(Boolean).length;

      return React.createElement('section', {
        className: 'ogp-group ogp-groupDivided',
        'aria-label': t('advancedTitle'),
      },
        React.createElement('button', {
          type: 'button',
          className: 'ogp-groupHead ogp-disclosure',
          'aria-expanded': open,
          onClick: () => setOpen(prev => !prev),
        },
          React.createElement('span', { className: 'ogp-groupTitle' }, t('advancedTitle')),
          overridden > 0 ? React.createElement('span', { className: 'ogp-badge' },
            t('advancedOverridden').replace('{n}', String(overridden))) : null,
          !open && invalid ? React.createElement('span', { className: 'ogp-badge ogp-badgeWarn' }, t('advancedInvalid')) : null,
          React.createElement('span', { className: 'ogp-spacer' }),
          React.createElement('span', {
            className: open ? 'ogp-chevron ogp-chevronUp' : 'ogp-chevron',
            'aria-hidden': 'true',
          }),
        ),
        open
          ? React.createElement('div', null,
              React.createElement('p', { className: 'ogp-groupDesc' }, t('advancedHint')),
              React.createElement(NumberField, {
                id: 'ogp-request-timeout',
                label: t('requestTimeout'),
                hint: t('requestTimeoutHint'),
                value: current.request,
                invalidReason: reading.request.ok ? undefined : reading.request.reason,
                disabled: busy !== null,
                t,
                overridden: overriddenFields.request,
                onChange: raw => onEdit('request', raw),
                onReset: () => onEdit('request', msToSecondsText(300000)),
              }),
              React.createElement(NumberField, {
                id: 'ogp-stream-idle-timeout',
                label: t('streamIdleTimeout'),
                hint: t('streamIdleTimeoutHint'),
                value: current.stream,
                invalidReason: reading.stream.ok ? undefined : reading.stream.reason,
                disabled: busy !== null,
                t,
                overridden: overriddenFields.stream,
                onChange: raw => onEdit('stream', raw),
                onReset: () => onEdit('stream', msToSecondsText(300000)),
              }),
              React.createElement(NumberField, {
                id: 'ogp-transport-retries',
                label: t('transportMaxRetries'),
                hint: t('transportMaxRetriesHint'),
                value: current.retries,
                invalidReason: reading.retries.ok ? undefined : 'invalid',
                disabled: busy !== null,
                t,
                overridden: overriddenFields.retries,
                onChange: raw => onEdit('retries', raw),
                onReset: () => onEdit('retries', '5'),
              }),
            )
          : null,
      );
    }

    /**
     * The floating save bar: what is staged and unsaved, with the two actions
     * that resolve it. Accounts never reach it — only configuration does.
     *
     * It stays mounted and animates, so a hidden bar keeps its last message
     * ready for the next appearance, and `visibility` takes its buttons out of
     * the tab order while it is away.
     */
    function SaveBar(props) {
      const { t, visible, tone, message, actions, onSave, onDiscard, saving } = props;
      const last = React.useRef({ tone, message, actions });
      if (visible) last.current = { tone, message, actions };
      const shown = visible ? { tone, message, actions } : last.current;
      const classes = ['ogp-saveBar', `ogp-saveBar-${shown.tone}`];
      if (visible) classes.push('ogp-saveBarShown');
      return React.createElement('div', { className: 'ogp-saveBarDock' },
        React.createElement('div', {
          className: classes.join(' '),
          role: 'region',
          'aria-label': t('unsavedChanges'),
          'aria-hidden': !visible,
        },
          React.createElement('span', { className: 'ogp-saveBarIcon', 'aria-hidden': 'true' },
            React.createElement('span', { className: 'ogp-saveBarPulse' })),
          React.createElement('p', { className: 'ogp-saveBarText', role: 'status', 'aria-live': 'polite', title: shown.message },
            shown.message),
          shown.actions
            ? React.createElement('div', { className: 'ogp-saveBarActions' },
                React.createElement('button', {
                  type: 'button',
                  className: 'ogp-saveBarButton ogp-saveBarGhost',
                  disabled: !visible || saving,
                  onClick: onDiscard,
                }, t('discard')),
                React.createElement('button', {
                  type: 'button',
                  className: 'ogp-saveBarButton ogp-saveBarPrimary',
                  disabled: !visible || saving,
                  onClick: onSave,
                }, t('save')),
              )
            : null,
        ),
      );
    }

    // -------------------------------------------------------------- the page

    function PoolPage(props) {
      const { t, store } = props;
      const snapshot = React.useSyncExternalStore(store.subscribe, store.get, store.get);
      const [tick, setTick] = React.useState(() => Date.now());
      const [staged, setStaged] = React.useState(null);
      const [fetching, setFetching] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [savedFlash, setSavedFlash] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);

      React.useEffect(() => store.retain(), [store]);
      React.useEffect(() => {
        const timer = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      // The success confirmation is a flash, not a state: it clears itself.
      React.useEffect(() => {
        if (!savedFlash) return undefined;
        const timer = setTimeout(() => setSavedFlash(false), 2500);
        return () => clearTimeout(timer);
      }, [savedFlash]);

      const data = snapshot.data;
      const busy = snapshot.busy;
      const notice = snapshot.notice;

      // The staged configuration: what the host holds, overlaid with whatever
      // the user has edited but not yet saved.
      const available = Array.isArray(data && data.availableModels) ? data.availableModels : [];
      const baseline = data === null ? null : stagedConfig(data, available);
      const current = staged ?? baseline;
      const reading = current === null ? null : readStaged(current);
      const patch = current === null ? null : stagedPatch(current, baseline, reading);
      const dirty = staged !== null && patch !== null;
      const valid = reading === null ? true : stagedValid(reading);

      const edit = (field, value) => setStaged({ ...(staged ?? baseline), [field]: value });
      const setModelMode = (mode) => {
        const source = staged ?? baseline;
        setStaged({ ...source, mode, ids: mode === 'all' ? available.map(model => model.id) : source.ids });
      };
      const toggleModel = (modelId) => {
        const source = staged ?? baseline;
        const ids = source.ids.includes(modelId)
          ? source.ids.filter(id => id !== modelId)
          : [...source.ids, modelId];
        setStaged({ ...source, mode: 'custom', ids });
      };

      const save = async () => {
        if (patch === null || !valid) return;
        setSaving(true);
        setSaveError(null);
        try {
          const remote = await store.remote();
          if (!remote) throw new Error('the opencodePool remote is not mounted');
          unwrapRemote(await remote.putConfig(patch));
          setStaged(null);
          setSavedFlash(true);
          await store.refresh();
        } catch (error) {
          setSaveError(messageOf(error));
        } finally {
          setSaving(false);
        }
      };
      const discard = () => { setStaged(null); setSaveError(null); };

      const actions = {
        tick,
        refreshing: snapshot.loading,
        refresh: () => store.refresh(),
        setActive: (id) => { void store.run(remote => remote.setActive(id), t('confirmSwitch')); },
        setDisabled: (id, on) => {
          void store.run(remote => remote.setDisabled(id, on), on ? t('confirmDisable') : null);
        },
        clearInvalid: (id) => { void store.run(remote => remote.clearInvalid(id), t('confirmClear')); },
        setKey: (id, secret) => store.run(async (remote) => {
          unwrapRemote(await remote.putKeySecret(id, secret));
          store.setNotice({ ok: true, code: 'saved' });
        }),
        rename: (id, label) => store.run(async remote => {
          const keys = (data.keys || []).map(key => ({
            id: key.id,
            label: key.id === id ? label.trim() : key.label,
            apiKeyEnv: key.apiKeyEnv,
          }));
          await remote.putKeys(keys);
        }),
        remove: (id) => store.run(async remote => {
          const keys = (data.keys || [])
            .filter(key => key.id !== id)
            .map(key => ({ id: key.id, label: key.label, apiKeyEnv: key.apiKeyEnv }));
          await remote.putKeys(keys);
        }),
        addAccount: (name, secret) => addAccount(store, data, name, secret),
      };

      const onFetchModels = async () => {
        setFetching(true);
        store.clearNotice();
        try {
          const remote = await store.remote();
          if (!remote) throw new Error('the opencodePool remote is not mounted');
          const result = unwrapRemote(await remote.refreshModels());
          await store.refresh();
          store.setNotice({
            ok: true,
            code: 'modelFetched',
            detail: t('modelFetched')
              .replace('{count}', String(result && result.count))
              .replace('{added}', String(Array.isArray(result && result.added) ? result.added.length : 0)),
          });
        } catch (error) {
          store.setNotice({ ok: false, code: 'modelFetchFailed', detail: messageOf(error) });
        } finally {
          setFetching(false);
        }
      };

      const takeover = data ? data.takeover : null;
      const badge = takeoverBadge(takeover, t);

      // The bar's own state: what it says, how it reads and whether it offers
      // the two actions. A failed save outranks an invalid draft, which
      // outranks the plain "unsaved changes", and a landed save shows its
      // confirmation with no actions at all.
      const barVisible = dirty || saving || saveError !== null || savedFlash;
      const barTone = saveError !== null || (dirty && !valid)
        ? 'error'
        : (savedFlash && !dirty ? 'success' : 'pending');
      const barMessage = saveError !== null
        ? `${t('saveFailed')}: ${saveError}`
        : (dirty && !valid)
          ? t('saveInvalid')
          : (savedFlash && !dirty)
            ? t('saved')
            : saving ? t('saving') : t('unsavedChanges');

      return React.createElement('section', {
        className: barVisible ? 'ogp-section ogp-sectionWithBar' : 'ogp-section',
        'aria-label': t('title'),
      },
        React.createElement('div', { className: 'ogp-header' },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h2', { className: 'ogp-title' }, t('title')),
            React.createElement('p', { className: 'ogp-subtitle' }, t('subtitle')),
          ),
          React.createElement('span', { className: 'ogp-spacer' }),
          // The takeover state is a label on the title row, not a banner: green
          // once the official route is actually served, amber otherwise.
          React.createElement('span', { className: badge.cls, title: badge.text }, badge.text),
        ),

        // The first status() is a local read, so this placeholder is visible for
        // milliseconds — and it is a hint under the title, never a page that
        // replaces the structure.
        data === null && snapshot.error === null
          ? React.createElement('p', { className: 'ogp-hint' }, t('loading'))
          : null,

        snapshot.error !== null
          ? React.createElement('div', { className: 'ogp-notice ogp-noticeWarn' },
              React.createElement('p', { className: 'ogp-noticeTitle' },
                `${t('loadFailed')}: ${snapshot.error}`),
              snapshot.failures >= 3 ? React.createElement('p', { className: 'ogp-hint' }, t('paused')) : null,
              React.createElement('div', { className: 'ogp-actions' },
                React.createElement(LinkButton, {
                  onClick: () => { store.setNotice(null); store.refresh(); },
                }, t('reload')),
              ),
            )
          : null,

        data === null
          ? null
          : React.createElement(React.Fragment, null,
              // The waiting state keeps its actionable guidance: the badge names
              // the state, but only this tells the user how to hand the route
              // over. Everything else about the takeover is the badge's job.
              takeover === 'waiting'
                ? React.createElement('div', { className: 'ogp-notice ogp-noticeWarn' },
                    React.createElement('p', { className: 'ogp-noticeTitle' }, t('takeoverWaiting')),
                    React.createElement('p', { className: 'ogp-hint' },
                      data.takeoverHint
                        ? `${t('takeoverWaitingHint')} ${data.takeoverHint}`
                        : t('takeoverWaitingHint')),
                  )
                : null,

              data.settingsAvailable === false
                ? React.createElement('div', { className: 'ogp-notice ogp-noticeWarn' },
                    React.createElement('p', { className: 'ogp-noticeTitle' }, t('settingsUnavailable')),
                    data.settingsHint ? React.createElement('p', { className: 'ogp-hint' }, data.settingsHint) : null,
                  )
                : null,

              React.createElement(AccountsGroup, {
                t, data, busy, current, reading, onEdit: edit, actions,
                loadedAt: snapshot.loadedAt,
              }),

              React.createElement(ModelsGroup, {
                t, data, busy, current, fetching,
                onSetMode: setModelMode,
                onToggleModel: toggleModel,
                onFetch: onFetchModels,
              }),

              React.createElement(IntegrationsGroup, { t, busy, current, onEdit: edit }),

              React.createElement(AdvancedGroup, { t, data, busy, current, reading, onEdit: edit }),
            ),

        notice !== null
          ? React.createElement('p', {
              className: notice.ok ? 'ogp-hint' : 'ogp-error',
              role: 'status',
            }, noticeText(notice, t))
          : null,

        React.createElement(SaveBar, {
          t,
          visible: barVisible,
          tone: barTone,
          message: barMessage,
          actions: (dirty || saveError !== null) && !saving,
          saving,
          onSave: () => { void save(); },
          onDiscard: discard,
        }),
      );
    }

    function switchReasonText(reason, t) {
      if (reason === 'quota') return t('switchQuota');
      if (reason === 'invalid') return t('switchInvalid');
      if (reason === 'consecutive') return t('switchConsecutive');
      return t('switchManual');
    }

    /**
     * Add one account: the row is written first, then the secret through the
     * credentials seam under the row's own reference. Both writes share one
     * store op, so a failure surfaces as a single notice and the page reloads
     * from the host's own state.
     */
    function addAccount(store, data, name, secret) {
      const id = nextKeyId(data);
      const apiKeyEnv = 'OPENCODE_GO_KEY_' + id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      return store.run(async (remote) => {
        const keys = [
          ...(data.keys || []).map(key => ({ id: key.id, label: key.label, apiKeyEnv: key.apiKeyEnv })),
          { id, label: name, apiKeyEnv },
        ];
        unwrapRemote(await remote.putKeys(keys));
        unwrapRemote(await remote.putKeySecret(id, secret));
      });
    }

    /** A fresh pool key id, derived from what is already configured. */
    function nextKeyId(data) {
      const taken = new Set((data.keys || []).map(key => key.id));
      for (let index = 1; index < 1000; index += 1) {
        const id = `key-${index}`;
        if (!taken.has(id)) return id;
      }
      return `key-${Date.now().toString(36)}`;
    }

    // --------------------------------------------------------- dashboard

    function QuotaPanel(props) {
      const { t, store, close } = props;
      const snapshot = React.useSyncExternalStore(store.subscribe, store.get, store.get);
      const [tick, setTick] = React.useState(() => Date.now());
      React.useEffect(() => store.retain(), [store]);
      React.useEffect(() => {
        const timer = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
      const data = snapshot.data;
      const keys = Array.isArray(data && data.keys) ? data.keys : [];
      return React.createElement('div', { className: 'ogp-main', role: 'region', 'aria-label': t('panelTitle') },
        React.createElement('div', { className: 'ogp-mainInner' },
          React.createElement('div', { className: 'ogp-header' },
            React.createElement('div', { style: { minWidth: 0 } },
              React.createElement('h2', { className: 'ogp-title' }, t('panelTitle')),
              React.createElement('p', { className: 'ogp-subtitle' }, t('panelSubtitle')),
            ),
            React.createElement('span', { className: 'ogp-spacer' }),
            snapshot.loadedAt
              ? React.createElement('span', { className: 'ogp-meta' },
                  `${t('updatedAt')} ${snapshot.loadedAt.toLocaleTimeString()}`)
              : null,
            React.createElement(LinkButton, {
              disabled: snapshot.loading,
              onClick: () => store.refresh(),
            }, snapshot.loading ? t('refreshing') : t('refresh')),
            React.createElement(Button, {
              className: 'ogp-close',
              'aria-label': t('close'),
              title: t('closeHint'),
              onClick: close,
            }, React.createElement('span', { 'aria-hidden': 'true' }, '×')),
          ),

          data === null && snapshot.error === null
            ? React.createElement('p', { className: 'ogp-hint' }, t('loading'))
            : null,
          snapshot.error !== null
            ? React.createElement('p', { className: 'ogp-error' }, `${t('loadFailed')}: ${snapshot.error}`)
            : null,
          data !== null && keys.length === 0
            ? React.createElement('div', { className: 'ogp-notice' },
                React.createElement('p', { className: 'ogp-noticeTitle' }, t('noKeysTitle')),
                React.createElement('p', { className: 'ogp-hint' }, t('noKeysHint')),
              )
            : null,

          keys.map(item => React.createElement('section', {
            key: item.id,
            className: item.active ? 'ogp-accountItem ogp-accountItemActive' : 'ogp-accountItem',
            'aria-label': item.label,
          },
            React.createElement('div', { className: 'ogp-accountHead' },
              React.createElement('span', { className: statusDotClass(item), 'aria-hidden': 'true' }),
              React.createElement('span', { className: 'ogp-accountName' }, item.label),
              item.active ? React.createElement('span', { className: 'ogp-badge' }, t('activeBadge')) : null,
              item.state === 'exhausted' ? React.createElement('span', { className: 'ogp-badge ogp-badgeWarn' }, t('exhaustedBadge')) : null,
              item.state === 'invalid' ? React.createElement('span', { className: 'ogp-badge ogp-badgeError' }, t('invalidBadge')) : null,
              item.state === 'disabled' ? React.createElement('span', { className: 'ogp-badgeMuted' }, t('disabledBadge')) : null,
            ),
            item.usage !== null && item.usage !== undefined
              ? React.createElement('div', { className: 'ogp-windows' },
                  React.createElement(UsageWindow, { label: t('rolling'), windowData: item.usage.rolling, t, tick }),
                  React.createElement(UsageWindow, { label: t('weekly'), windowData: item.usage.weekly, t, tick }),
                  React.createElement(UsageWindow, { label: t('monthly'), windowData: item.usage.monthly, t, tick }),
                )
              : React.createElement('p', { className: 'ogp-hint' },
                  item.usageError ? usageErrorText(item.usageError, t) : t('usagePending')),
          )),
        ),
      );
    }

    // ------------------------------------------------------ sidebar card

    /**
     * The sidebar-foot quota card.
     *
     * Registered in `sidebar.footer.action` — the list the sidebar renders in
     * its foot area directly above the Settings seat — so it reads as a
     * bottom-pinned sibling of Settings rather than a global panel icon.
     *
     * It renders NOTHING and opens NO poll while `showSidebarQuota` is off: the
     * visibility flag rides the cheap, network-free `status()` read, so a fresh
     * install runs no background traffic at all from this surface. Once on, it
     * shows the serving account's windows and opens the dashboard.
     */
    function QuotaFooterCard(props) {
      const { t, store, wide, open } = props;
      const snapshot = React.useSyncExternalStore(store.subscribe, store.get, store.get);
      const known = snapshot.data !== null;
      const visible = known && snapshot.data.showSidebarQuota === true;

      React.useEffect(() => {
        if (!known) {
          void store.probeOnce();
          return undefined;
        }
        if (!visible) return undefined;
        return store.retain();
      }, [known, visible, store]);

      if (!visible) return null;

      const keys = Array.isArray(snapshot.data.keys) ? snapshot.data.keys : [];
      const serving = keys.find(key => key.active) ?? keys[0];
      const usage = (serving && serving.usage) || {};
      const rolling = usage.rolling ?? null;
      const weekly = usage.weekly ?? null;
      const headline = rolling ?? weekly;
      const headlinePercent = headline && typeof headline.percent === 'number' ? headline.percent : 0;
      const title = serving
        ? `${t('panelTitle')} · ${serving.label}`
        : `${t('panelTitle')} · ${t('footNoData')}`;

      const bars = [
        { key: 'rolling', label: t('rolling'), windowData: rolling },
        { key: 'weekly', label: t('weekly'), windowData: weekly },
      ];

      if (!wide) {
        return React.createElement('button', {
          type: 'button',
          className: 'ogp-railButton',
          'aria-label': title,
          title,
          onClick: open,
        }, React.createElement(Ring, { percent: headlinePercent, warn: headlinePercent >= 90, size: 18 }));
      }

      return React.createElement('button', {
        type: 'button',
        className: 'ogp-foot',
        'aria-label': title,
        title,
        onClick: open,
      },
        React.createElement('span', { className: 'ogp-footTop' },
          React.createElement(Ring, { percent: headlinePercent, warn: headlinePercent >= 90, size: 16 }),
          React.createElement('span', { className: 'ogp-footName' }, t('nav')),
          React.createElement('span', { className: 'ogp-spacer' }),
          serving
            ? React.createElement('span', { className: 'ogp-badgeMuted' }, serving.label)
            : null,
        ),
        bars.map(bar => React.createElement('span', { className: 'ogp-footRow', key: bar.key },
          React.createElement('span', { className: 'ogp-footHead' },
            React.createElement('span', { className: 'ogp-footLabel' }, bar.label),
            React.createElement('span', { className: 'ogp-spacer' }),
            React.createElement('span', { className: 'ogp-footPct' },
              bar.windowData && typeof bar.windowData.percent === 'number'
                ? `${bar.windowData.percent}%`
                : '—'),
          ),
          React.createElement('span', { className: 'ogp-footBar' },
            React.createElement('span', {
              className: barTone(bar.windowData) === 'flat' ? 'ogp-footFill' : 'ogp-footFill ogp-footFillWarn',
              style: { width: `${barPercent(bar.windowData)}%` },
            }),
          ),
        )),
      );
    }

    // ----------------------------------------------------------------- apply

    function injectCss(id, css) {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-opencode-go-pool';
      tag.dataset.pluginCss = id;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * The nav-row label: the row's mark plus its text, like every sibling.
     *
     * The mark is also what the stylesheet keys on to hide the gear the shell
     * hardcodes for an unknown section id (see SparkleNavMark), so it must stay
     * on this element.
     */
    function navLabel(t) {
      return React.createElement(React.Fragment, null,
        React.createElement(SparkleNavMark, { className: 'dsh-ogp-nav-mark' }),
        React.createElement('span', null, t('nav')),
      );
    }

    /** The layout seam, read reflectively: ui-layout is not our dependency. */
    function layoutOf(ctx) {
      const layout = ctx.get('layout');
      return layout && typeof layout.selectPanel === 'function' ? layout : null;
    }

    /**
     * Mount this plugin's Remote contribution.
     *
     * The registry rejects a contribution that names an invocation the Host does
     * not declare, so a browser holding this bundle across a Host upgrade — the
     * HMR swap lands the client half first — would otherwise lose EVERY surface
     * until the page was reloaded against the new Host. The fallback drops the
     * one endpoint the split added and keeps the rest working; the account rows
     * then keep whatever the last completed pass produced instead of failing.
     */
    async function mountRemote(ctx, contribution) {
      try {
        return await ctx.remote.$mount(contribution);
      } catch (error) {
        console.warn('[dsh-opencode-go-pool] retrying without the usage endpoint:', error);
        return ctx.remote.$mount({
          ...contribution,
          descriptors: contribution.descriptors.filter(descriptor => descriptor.method !== 'usage'),
        });
      }
    }

    function apply(ctx) {
      ctx.effect(() => injectCss(CSS_ID, CSS), 'dsh-opencode-go-pool: styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-opencode-go-pool: page copy');
      ctx.effect(
        () => ctx.locale.register(PANEL_NS, { zh: panelZh, en: panelEn }),
        'dsh-opencode-go-pool: panel copy',
      );
      const t = ctx.locale.bind(NS);
      const panelT = () => ctx.locale.bind(PANEL_NS);

      const mountReady = mountRemote(ctx, TYPERT_REMOTE);
      const api = async () => {
        await mountReady;
        return ctx.get('remote.opencodePool') || null;
      };
      const store = createPoolStore(api);
      store.remote = api;
      ctx.effect(() => () => store.dispose(), 'dsh-opencode-go-pool: store');

      const openPanel = () => { layoutOf(ctx)?.selectPanel(PANEL_ID); };
      const closePanel = () => { layoutOf(ctx)?.selectPanel(null); };

      // Error boundary: any render crash inside a surface becomes a VISIBLE
      // diagnostic instead of a blank column, so problems self-report.
      class PoolPageBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error };
        }
        render() {
          if (this.state.error !== null) {
            const err = this.state.error;
            return React.createElement('div', {
              style: {
                padding: 16,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                borderRadius: 10,
                color: 'var(--dsw-alias-state-error-primary)',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              },
            },
              React.createElement('p', { style: { margin: 0, fontWeight: 600 } }, 'OpenCode Go 套餐池 · 渲染异常'),
              React.createElement('p', { style: { margin: '8px 0 0' } }, messageOf(err)),
              React.createElement('p', { style: { margin: '8px 0 0', opacity: 0.75 } },
                String((err && err.stack) || '').slice(0, 1200)),
            );
          }
          return React.createElement(PoolPage, this.props);
        }
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'opencode-go-pool',
        order: 41,
        label: () => {
          try {
            return navLabel(t);
          } catch {
            // Degrade to plain text if the shell ever rejects element labels.
            return t('nav');
          }
        },
        locale: NS,
        inject: () => ({ t, store }),
      }, PoolPageBoundary));

      // The dashboard the sidebar card opens: a keyed `main` cell under the
      // same id, so the two are one navigation entry.
      try {
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: PANEL_NS, inject: () => ({ t: panelT(), store, close: closePanel }) },
          QuotaPanel,
        ));
      } catch (error) {
        console.error('[dsh-opencode-go-pool] could not register the quota panel:', error);
      }

      // The card itself, registered only where a layout can open the panel
      // behind it — a profile without ui-layout never gets a dead button.
      ctx.inject(['layout'], (layoutCtx) => {
        try {
          layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: PANEL_ID,
              order: 1,
              locale: PANEL_NS,
              inject: () => ({ t: panelT(), store, open: openPanel }),
            },
            QuotaFooterCard,
          ));
        } catch (error) {
          console.error('[dsh-opencode-go-pool] could not register the sidebar quota card:', error);
        }
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    // Render-path test hooks (unused by the runtime; see test/client.test.mjs).
    exports.__test = {
      PoolPage, QuotaPanel, QuotaFooterCard, AccountItem, AddAccountPanel, ModelsGroup, AdvancedGroup,
      IntegrationsGroup, AccountsGroup, SaveBar, KebabMenu, UsageWindow, MiniMeter, Ring,
      createPoolStore, mergeUsage, barPercent, barTone, formatReset, usageErrorText, noticeText,
      statusDotClass, stateBadge, takeoverBadge, stagedConfig, readStaged, stagedValid, stagedPatch,
      msToSecondsText, secondsTextToMs, unwrapRemote, TYPERT_REMOTE, PANEL_ID, CSS_ID,
    };
    return module.exports;
  },
});
