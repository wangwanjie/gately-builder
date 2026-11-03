// Gately 定制构建页面：读取所选版本的 modules.json 生成选项，提交到构建器 API，轮询进度并在完成时通知。
'use strict'

// 本地调试可用 ?api= 指向本机 API，正式页面只用 config.js 中的地址
const params = new URLSearchParams(location.search)
const API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && params.get('api')) || window.GATELY_BUILDER_API
const JOB_KEY = 'gately-builder.job'
const UI_LANG_KEY = 'gately-builder.lang'
const POLL_MS = 10000

const TEXT = {
  'zh-CN': {
    'nav.site': '官网',
    'nav.releases': '完整版下载',
    'hero.title': '只装你用得到的功能',
    'hero.lead': '勾选需要的功能模块、平台和界面语言，生成更小的 Gately 安装包，适合存储空间和内存有限的路由器、ARM 盒子与 NAS。已经有人构建过的组合直接下载。',
    'step.version': '选择版本',
    'step.versionHint': '只列出支持定制构建的正式版本。',
    'step.platform': '选择平台',
    'step.dockerHint': 'Docker 请直接使用官方镜像：',
    'step.modules': '选择功能',
    'step.lang': '界面语言',
    'sheet.size': '预计程序大小',
    'sheet.modules': '功能',
    'sheet.platforms': '平台',
    'sheet.lang': '语言',
    'sheet.submit': '生成安装包',
    'job.title': '构建进度',
    'foot.note': '安装包由 GitHub Actions 从 Gately 开源仓库的对应版本构建，构建记录公开可查。',
    'foot.runs': '查看构建记录',
    'group.linux': 'Linux',
    'group.fnos': '飞牛 fnOS',
    'group.openwrt': 'OpenWrt',
    'group.other': '其他系统',
    core: '必选',
    dep: '被依赖',
    custom: '自定义',
    sizeNote: '比完整版小 {mb} MB，按 linux/arm64 估算',
    sizeFull: '与完整版相同，可以直接到发布页下载',
    modulesCount: '核心模块与 {n} 个可选功能',
    noPlatform: '还没有选择平台',
    addedNote: '已自动勾选被依赖的功能：{list}',
    removedNote: '已一并取消依赖它的功能：{list}',
    needPlatform: '至少选择一个平台',
    'state.done': '可以下载',
    'state.building': '正在构建',
    'state.queued': '排队中',
    'state.failed': '构建失败',
    'state.idle': '等待提交',
    viewLog: '查看日志',
    jobHint: '每个平台单独构建，通常 3 到 6 分钟。可以关闭页面，之后用同样的选项再来，会直接得到下载链接。',
    jobDone: '全部构建完成。',
    jobFailed: '有平台构建失败，可以查看日志后再次点击“生成安装包”重试。',
    notifyTitle: 'Gately 安装包已生成',
    notifyBody: '{n} 个平台可以下载了',
    loadFailed: '构建服务暂时无法访问：{error}。可以先到发布页下载完整版。',
    noVersions: '还没有支持定制构建的版本。下一个正式版发布后即可使用。',
    submitFailed: '提交失败：{error}',
  },
  en: {
    'nav.site': 'Website',
    'nav.releases': 'Full downloads',
    'hero.title': 'Install only the features you use',
    'hero.lead': 'Pick the modules, platforms and UI languages you need to get a smaller Gately package for routers, ARM boxes and NAS devices with little storage or memory. Combinations someone already built download right away.',
    'step.version': 'Choose a version',
    'step.versionHint': 'Only releases that support custom builds are listed.',
    'step.platform': 'Choose platforms',
    'step.dockerHint': 'For Docker, use the official image:',
    'step.modules': 'Choose features',
    'step.lang': 'UI languages',
    'sheet.size': 'Estimated size',
    'sheet.modules': 'Features',
    'sheet.platforms': 'Platforms',
    'sheet.lang': 'Languages',
    'sheet.submit': 'Build packages',
    'job.title': 'Build progress',
    'foot.note': 'Packages are built by GitHub Actions from the matching version of the open-source Gately repository, and every build log is public.',
    'foot.runs': 'View build logs',
    'group.linux': 'Linux',
    'group.fnos': 'fnOS',
    'group.openwrt': 'OpenWrt',
    'group.other': 'Other systems',
    core: 'Required',
    dep: 'Dependency',
    custom: 'Custom',
    sizeNote: '{mb} MB smaller than the full edition, estimated for linux/arm64',
    sizeFull: 'Same as the full edition, which you can download from the releases page',
    modulesCount: 'Core modules and {n} optional features',
    noPlatform: 'No platform selected yet',
    addedNote: 'Also selected because they are required: {list}',
    removedNote: 'Also removed because they depend on it: {list}',
    needPlatform: 'Choose at least one platform',
    'state.done': 'Ready',
    'state.building': 'Building',
    'state.queued': 'Queued',
    'state.failed': 'Failed',
    'state.idle': 'Not submitted',
    viewLog: 'View log',
    jobHint: 'Each platform builds separately, usually in 3 to 6 minutes. You can close this page and come back with the same options later to get the download links.',
    jobDone: 'All builds are ready.',
    jobFailed: 'Some platforms failed to build. Check the log, then select Build packages again to retry.',
    notifyTitle: 'Gately packages are ready',
    notifyBody: '{n} platforms ready to download',
    loadFailed: 'The build service is unreachable: {error}. You can download the full edition from the releases page.',
    noVersions: 'No release supports custom builds yet. They will be available from the next release.',
    submitFailed: 'Submission failed: {error}',
  },
}

// 平台的显示名称，未列出的目标显示 ID
const ARCH = { amd64: 'x86_64', arm64: 'ARM64', arm: 'ARMv7', mipsle: 'MIPS LE', mips: 'MIPS', riscv64: 'RISC-V 64' }

let ui = localStorage.getItem(UI_LANG_KEY) || (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
const state = {
  versions: [],
  version: '',
  manifest: null,
  targets: new Set(),
  modules: new Set(),
  // 因依赖自动勾选的模块，界面上单独标出
  auto: new Set(),
  lang: 'all',
  note: '',
  job: null,
  timer: 0,
}

const $ = (id) => document.getElementById(id)
const t = (key, vars = {}) => (TEXT[ui][key] ?? TEXT['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
const pick = (obj) => (obj ? obj[ui] ?? obj.en ?? obj['zh-CN'] : '')
const mb = (kb) => (kb / 1024).toFixed(1)

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      node.className = v
    } else if (k.startsWith('on')) {
      node.addEventListener(k.slice(2), v)
    } else if (v !== false && v != null) {
      node.setAttribute(k, v === true ? '' : v)
    }
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) {
      node.append(c)
    }
  }
  return node
}

async function api(path, init) {
  const resp = await fetch(API + path, init)
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`)
  }
  return data
}

function applyStaticText() {
  document.documentElement.lang = ui
  document.querySelectorAll('[data-i18n]').forEach((n) => {
    n.textContent = t(n.dataset.i18n)
  })
  $('lang-toggle').textContent = ui === 'zh-CN' ? 'English' : '简体中文'
  document.title = ui === 'zh-CN' ? 'Gately 定制构建' : 'Gately custom builds'
}

// ---------- 版本 ----------

async function loadVersions() {
  try {
    state.versions = (await api('/api/versions')).versions
  } catch (e) {
    showLoadError(t('loadFailed', { error: e.message }))
    return
  }
  if (state.versions.length === 0) {
    showLoadError(t('noVersions'))
    return
  }
  const sel = $('version')
  sel.replaceChildren(...state.versions.map((v) => el('option', { value: v.version }, v.version)))
  const wanted = params.get('version')
  sel.value = state.versions.some((v) => v.version === wanted) ? wanted : state.versions[0].version
  sel.addEventListener('change', () => loadManifest(sel.value, false))
  await loadManifest(sel.value, true)
}

function showLoadError(msg) {
  const box = $('load-error')
  box.textContent = msg
  box.hidden = false
}

async function loadManifest(version, initial) {
  try {
    state.manifest = await api(`/api/manifest?version=${encodeURIComponent(version)}`)
  } catch (e) {
    showLoadError(t('loadFailed', { error: e.message }))
    return
  }
  state.version = version
  const m = state.manifest
  const known = new Set(m.modules.filter((x) => !x.core).map((x) => x.id))
  const targetIds = new Set(m.targets.map((x) => x.id))
  if (initial) {
    // 地址栏参数优先（Gately 关于页的“按当前选项生成新版本”会带上），其次是上次提交的选项
    const saved = loadJob()
    const src = params.has('modules') || params.has('lang') ? Object.fromEntries(params) : saved ? { modules: saved.modules.join(','), lang: saved.lang, targets: saved.targets.join(',') } : null
    if (src) {
      state.modules = new Set((src.modules || '').split(',').filter((id) => known.has(id)))
      state.lang = m.languages.some((l) => l.id === src.lang) ? src.lang : 'all'
      state.targets = new Set((src.targets || '').split(',').filter((id) => targetIds.has(id)))
    } else {
      state.modules = new Set(known)
      state.lang = 'all'
    }
  } else {
    state.modules = new Set([...state.modules].filter((id) => known.has(id)))
    state.targets = new Set([...state.targets].filter((id) => targetIds.has(id)))
    if (!m.languages.some((l) => l.id === state.lang)) {
      state.lang = 'all'
    }
  }
  closeDeps()
  render()
  if (initial && loadJob()) {
    resumeJob()
  }
}

// ---------- 依赖 ----------

// closeDeps 补齐已勾选模块依赖的模块，返回新补上的模块
function closeDeps() {
  const added = []
  for (let changed = true; changed; ) {
    changed = false
    for (const m of state.manifest.modules) {
      if (!state.modules.has(m.id)) {
        continue
      }
      for (const dep of m.requires || []) {
        const d = state.manifest.modules.find((x) => x.id === dep)
        if (d && !d.core && !state.modules.has(dep)) {
          state.modules.add(dep)
          state.auto.add(dep)
          added.push(dep)
          changed = true
        }
      }
    }
  }
  return added
}

// dependents 返回直接或间接依赖 id 的已勾选模块
function dependents(id) {
  const out = new Set()
  for (let changed = true; changed; ) {
    changed = false
    for (const m of state.manifest.modules) {
      if (state.modules.has(m.id) && !out.has(m.id) && (m.requires || []).some((r) => r === id || out.has(r))) {
        out.add(m.id)
        changed = true
      }
    }
  }
  return [...out]
}

function title(id) {
  return pick(state.manifest.modules.find((m) => m.id === id)?.title) || id
}

function toggleModule(id, on) {
  state.note = ''
  if (on) {
    state.modules.add(id)
    state.auto.delete(id)
    const added = closeDeps()
    if (added.length) {
      state.note = t('addedNote', { list: added.map(title).join('、') })
    }
  } else {
    const deps = dependents(id)
    state.modules.delete(id)
    state.auto.delete(id)
    deps.forEach((d) => state.modules.delete(d))
    if (deps.length) {
      state.note = t('removedNote', { list: deps.map(title).join('、') })
    }
  }
  render()
}

function applyPreset(p) {
  state.modules = new Set(p ? p.modules : state.manifest.modules.filter((m) => !m.core).map((m) => m.id))
  state.auto.clear()
  state.note = ''
  closeDeps()
  render()
}

// ---------- 渲染 ----------

function platformLabel(tg) {
  if (tg.kind === 'fpk') {
    return tg.platform === 'x86' ? 'x86' : 'ARM'
  }
  if (tg.goos !== 'linux') {
    const os = { windows: 'Windows', darwin: 'macOS', freebsd: 'FreeBSD' }[tg.goos] || tg.goos
    const arch = tg.goos === 'darwin' && tg.goarch === 'arm64' ? (ui === 'zh-CN' ? 'Apple 芯片' : 'Apple silicon') : ARCH[tg.goarch] || tg.goarch
    return `${os} ${arch}`
  }
  return ARCH[tg.goarch] || tg.goarch
}

function targetGroup(tg) {
  if (tg.kind === 'fpk') {
    return 'fnos'
  }
  if (tg.kind === 'openwrt') {
    return 'openwrt'
  }
  return tg.goos === 'linux' ? 'linux' : 'other'
}

function renderPlatforms() {
  const groups = ['linux', 'openwrt', 'fnos', 'other']
  $('platforms').replaceChildren(
    ...groups.map((g) => {
      const list = state.manifest.targets.filter((tg) => targetGroup(tg) === g)
      return el(
        'div',
        { class: 'platform-group', role: 'group', 'aria-label': t('group.' + g) },
        el('span', {}, t('group.' + g)),
        el(
          'div',
          { class: 'chips' },
          list.map((tg) =>
            el(
              'span',
              { class: 'chip' },
              el('input', {
                type: 'checkbox',
                id: 'tg-' + tg.id,
                checked: state.targets.has(tg.id),
                onchange: (e) => {
                  e.target.checked ? state.targets.add(tg.id) : state.targets.delete(tg.id)
                  renderSheet()
                },
              }),
              el('label', { for: 'tg-' + tg.id }, platformLabel(tg)),
            ),
          ),
        ),
      )
    }),
  )
}

function currentPreset() {
  const sel = [...state.modules].sort().join(',')
  const all = state.manifest.modules.filter((m) => !m.core).map((m) => m.id)
  if (sel === [...all].sort().join(',')) {
    return 'all'
  }
  const p = (state.manifest.presets || []).find((x) => [...x.modules].sort().join(',') === sel)
  return p ? p.id : 'custom'
}

function renderPresets() {
  const cur = currentPreset()
  const full = { id: 'all', title: { 'zh-CN': '全部功能', en: 'Everything' } }
  $('presets').replaceChildren(
    ...[full, ...(state.manifest.presets || [])].map((p) =>
      el('button', { type: 'button', class: 'preset', 'aria-pressed': String(cur === p.id), onclick: () => applyPreset(p.id === 'all' ? null : p) }, pick(p.title)),
    ),
  )
}

function renderModules() {
  const m = state.manifest
  $('modules').replaceChildren(
    ...m.groups.map((g) => {
      const mods = m.modules.filter((x) => x.group === g.id)
      return el(
        'div',
        { class: 'group' },
        el('h3', {}, pick(g.title)),
        mods.map((x) => {
          const checked = x.core || state.modules.has(x.id)
          const tags = []
          if (x.core) {
            tags.push(el('span', { class: 'tag core' }, t('core')))
          } else if (state.auto.has(x.id) && checked) {
            tags.push(el('span', { class: 'tag dep' }, t('dep')))
          }
          return el(
            'label',
            { class: 'mod' + (x.core ? ' locked' : '') },
            el('input', { type: 'checkbox', checked, disabled: x.core, onchange: (e) => toggleModule(x.id, e.target.checked) }),
            el('span', {}, el('span', { class: 'mod-title' }, pick(x.title)), tags, el('span', { class: 'mod-desc' }, pick(x.desc))),
            el('span', { class: 'mod-size' }, x.core || !x.sizeKB ? '' : `${mb(x.sizeKB)} MB`),
          )
        }),
      )
    }),
  )
}

function renderLanguages() {
  $('languages').replaceChildren(
    ...state.manifest.languages.map((l) =>
      el(
        'label',
        { class: 'lang-opt' },
        el('input', {
          type: 'radio',
          name: 'lang',
          value: l.id,
          checked: state.lang === l.id,
          onchange: () => {
            state.lang = l.id
            renderSheet()
          },
        }),
        el('span', {}, pick(l.title)),
        el('span', { class: 'mod-size' }, l.sizeKB ? `−${mb(l.sizeKB)} MB` : ''),
      ),
    ),
  )
}

function estimateKB() {
  const m = state.manifest
  let kb = m.baseSizeKB || 0
  for (const x of m.modules) {
    if (!x.core && !state.modules.has(x.id)) {
      kb -= x.sizeKB || 0
    }
  }
  kb -= m.languages.find((l) => l.id === state.lang)?.sizeKB || 0
  return kb
}

function renderSheet() {
  const m = state.manifest
  const base = m.baseSizeKB || 1
  const kb = estimateKB()
  $('size-value').textContent = `${mb(kb)} MB`
  $('size-fill').style.width = `${Math.max(4, (kb / base) * 100)}%`
  const saved = base - kb
  $('size-note').textContent = saved > 64 ? t('sizeNote', { mb: mb(saved) }) : t('sizeFull')
  $('sum-modules').textContent = t('modulesCount', { n: state.modules.size })
  const targets = m.targets.filter((tg) => state.targets.has(tg.id))
  $('sum-platforms').textContent = targets.length ? targets.map((tg) => `${t('group.' + targetGroup(tg))} ${platformLabel(tg)}`).join('，') : t('noPlatform')
  $('sum-lang').textContent = pick(m.languages.find((l) => l.id === state.lang)?.title)
  const note = $('added-note')
  note.textContent = state.note
  note.hidden = !state.note
  $('submit').disabled = targets.length === 0
  $('submit').title = targets.length ? '' : t('needPlatform')
  renderPresets()
}

function render() {
  renderPlatforms()
  renderModules()
  renderLanguages()
  renderSheet()
}

// ---------- 提交与进度 ----------

function selection() {
  const ids = (list) => state.manifest.targets.map((tg) => tg.id).filter((id) => list.has(id))
  return { version: state.version, modules: state.manifest.modules.filter((m) => state.modules.has(m.id)).map((m) => m.id), lang: state.lang, targets: ids(state.targets) }
}

function loadJob() {
  try {
    return JSON.parse(localStorage.getItem(JOB_KEY) || 'null')
  } catch {
    return null
  }
}

async function submit() {
  const err = $('submit-error')
  err.hidden = true
  const sel = selection()
  // 先请求通知权限，构建完成时提醒（用户拒绝也不影响构建）
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => undefined)
  }
  $('submit').disabled = true
  try {
    const data = await api('/api/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sel) })
    state.job = { ...sel, notified: false }
    localStorage.setItem(JOB_KEY, JSON.stringify(state.job))
    showJob(data)
  } catch (e) {
    err.textContent = t('submitFailed', { error: e.message })
    err.hidden = false
  } finally {
    $('submit').disabled = state.targets.size === 0
  }
}

function resumeJob() {
  const job = loadJob()
  if (!job || job.version !== state.version) {
    return
  }
  state.job = job
  poll()
}

async function poll() {
  clearTimeout(state.timer)
  const job = state.job
  if (!job) {
    return
  }
  const q = new URLSearchParams({ version: job.version, modules: job.modules.join(','), lang: job.lang, targets: job.targets.join(',') })
  try {
    showJob(await api(`/api/builds?${q}`))
  } catch {
    state.timer = setTimeout(poll, POLL_MS)
  }
}

function targetName(id) {
  const tg = state.manifest.targets.find((x) => x.id === id)
  return tg ? `${t('group.' + targetGroup(tg))} ${platformLabel(tg)}` : id
}

function showJob(data) {
  $('job').hidden = false
  $('job-list').replaceChildren(
    ...data.targets.map((s) =>
      el(
        'li',
        { class: 'job-item' },
        el('div', { class: 'job-row' }, el('span', {}, targetName(s.target)), el('span', { class: 'state ' + s.state }, t('state.' + s.state))),
        s.state === 'done'
          ? el(
              'ul',
              { class: 'files' },
              s.files.map((f) => el('li', {}, el('a', { href: f.url }, f.name), ` (${mb(f.size / 1024)} MB)`)),
            )
          : s.runUrl
            ? el('a', { href: s.runUrl, target: '_blank', rel: 'noopener', class: 'state' }, t('viewLog'))
            : null,
      ),
    ),
  )
  const pending = data.targets.some((s) => s.state === 'building' || s.state === 'queued' || s.state === 'idle')
  const failed = data.targets.some((s) => s.state === 'failed')
  $('job-hint').textContent = pending ? t('jobHint') : failed ? t('jobFailed') : t('jobDone')
  if (pending) {
    state.timer = setTimeout(poll, POLL_MS)
    return
  }
  const done = data.targets.filter((s) => s.state === 'done').length
  if (state.job && !state.job.notified && done > 0) {
    state.job.notified = true
    localStorage.setItem(JOB_KEY, JSON.stringify(state.job))
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(t('notifyTitle'), { body: t('notifyBody', { n: done }), icon: 'favicon.svg' })
    }
  }
}

// ---------- 启动 ----------

$('lang-toggle').addEventListener('click', () => {
  ui = ui === 'zh-CN' ? 'en' : 'zh-CN'
  localStorage.setItem(UI_LANG_KEY, ui)
  applyStaticText()
  if (state.manifest) {
    render()
    if (state.job) {
      poll()
    }
  }
})
$('submit').addEventListener('click', submit)
applyStaticText()
loadVersions()
