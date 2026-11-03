// Gately 定制构建页面：读取所选版本的 modules.json 生成选项，提交到构建器 API，轮询进度并在完成时通知。
'use strict'

// 本地调试可用 ?api= 指向本机 API，正式页面只用 config.js 中的地址
const params = new URLSearchParams(location.search)
const API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && params.get('api')) || window.GATELY_BUILDER_API
const KEY = { job: 'gately-builder.job', ui: 'gately-builder.lang', theme: 'gately-builder.theme' }
const POLL_MS = Number(params.get('poll')) || 10000
const TEXT = window.GATELY_TEXT
const UI_LANGS = ['zh-CN', 'zh-TW', 'en']
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const narrow = matchMedia('(max-width: 860px)')

// 平台的显示名称
const ARCH = { amd64: 'x86_64', arm64: 'ARM64', arm: 'ARMv7', mipsle: 'MIPS LE', mips: 'MIPS', riscv64: 'RISC-V 64' }
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>'

const state = {
  ui: detectUILang(),
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
  jobData: null,
  prev: {},
  timer: 0,
  tick: 0,
  shownKB: null,
  segsReady: false,
}

const $ = (id) => document.getElementById(id)
const t = (key, vars = {}) => (TEXT[state.ui][key] ?? TEXT['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
const mb = (kb) => (kb / 1024).toFixed(1)

// pick 从清单的多语言字段中取当前语言，繁体缺失时用简体，其余用英文
function pick(obj) {
  if (!obj) {
    return ''
  }
  return obj[state.ui] ?? (state.ui === 'zh-TW' ? obj['zh-CN'] : undefined) ?? obj.en ?? obj['zh-CN'] ?? ''
}

function detectUILang() {
  const saved = localStorage.getItem(KEY.ui)
  if (UI_LANGS.includes(saved)) {
    return saved
  }
  for (const raw of navigator.languages || [navigator.language]) {
    const l = String(raw).toLowerCase()
    if (/^zh-(tw|hk|mo|hant)/.test(l)) {
      return 'zh-TW'
    }
    if (l.startsWith('zh')) {
      return 'zh-CN'
    }
    if (l.startsWith('en')) {
      return 'en'
    }
  }
  return 'en'
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      node.className = v
    } else if (k === 'html') {
      node.innerHTML = v
    } else if (k === 'style') {
      node.style.cssText = v
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

function toast(msg) {
  const box = $('toast')
  box.textContent = msg
  box.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => box.classList.remove('show'), 2200)
}

// ---------- 语言与主题 ----------

function applyStaticText() {
  document.documentElement.lang = state.ui
  document.querySelectorAll('[data-i18n]').forEach((n) => {
    n.textContent = t(n.dataset.i18n)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((n) => {
    n.title = t(n.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-aria]').forEach((n) => {
    n.setAttribute('aria-label', t(n.dataset.i18nAria))
  })
  $('ui-lang').value = state.ui
  document.title = `Gately ${t('brand.sub')}`
}

function isDark(theme) {
  return theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
}

function renderThemeButtons() {
  const cur = document.documentElement.dataset.theme
  document.querySelectorAll('[data-theme-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeValue === cur)))
}

// setTheme 切换主题；外观确实改变时，新主题从按下的按钮处圆形展开
function setTheme(theme, origin) {
  const root = document.documentElement
  const changed = isDark(root.dataset.theme) !== isDark(theme)
  localStorage.setItem(KEY.theme, theme)
  const apply = () => {
    root.dataset.theme = theme
    renderThemeButtons()
  }
  if (!changed || !document.startViewTransition || reduceMotion.matches || !origin) {
    apply()
    return
  }
  const r = origin.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  document.startViewTransition(apply).ready.then(() => {
    root.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' })
  })
}

// ---------- 版本与清单 ----------

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
  await loadManifest(sel.value, true)
}

function showLoadError(msg) {
  const box = $('load-error')
  box.textContent = msg
  box.hidden = false
  box.dataset.msg = msg
}

function loadJob() {
  try {
    return JSON.parse(localStorage.getItem(KEY.job) || 'null')
  } catch {
    return null
  }
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
    const src = params.has('modules') || params.has('lang') || params.has('targets') ? Object.fromEntries(params) : saved ? { modules: saved.modules.join(','), lang: saved.lang, targets: saved.targets.join(',') } : null
    if (src) {
      state.modules = new Set(src.modules === undefined ? known : String(src.modules).split(',').filter((id) => known.has(id)))
      state.lang = m.languages.some((l) => l.id === src.lang) ? src.lang : 'all'
      state.targets = new Set(String(src.targets || '').split(',').filter((id) => targetIds.has(id)))
    } else {
      state.modules = new Set(known)
    }
  } else {
    state.modules = new Set([...state.modules].filter((id) => known.has(id)))
    state.targets = new Set([...state.targets].filter((id) => targetIds.has(id)))
    if (!m.languages.some((l) => l.id === state.lang)) {
      state.lang = 'all'
    }
  }
  state.auto.clear()
  closeDeps()
  state.segsReady = false
  render()
  if (initial) {
    const job = loadJob()
    if (job && job.version === state.version) {
      state.job = job
      poll()
    }
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

const moduleTitle = (id) => pick(state.manifest.modules.find((m) => m.id === id)?.title) || id

function toggleModule(id, on) {
  state.note = ''
  if (on) {
    state.modules.add(id)
    state.auto.delete(id)
    const added = closeDeps()
    if (added.length) {
      state.note = t('addedNote', { list: added.map(moduleTitle).join(t('sep')) })
    }
  } else {
    const deps = dependents(id)
    state.modules.delete(id)
    state.auto.delete(id)
    deps.forEach((d) => state.modules.delete(d))
    if (deps.length) {
      state.note = t('removedNote', { list: deps.map(moduleTitle).join(t('sep')) })
    }
  }
  renderModules()
  renderSummary()
}

function applyPreset(ids) {
  state.modules = new Set(ids)
  state.auto.clear()
  state.note = ''
  closeDeps()
  renderModules()
  renderSummary()
}

// ---------- 渲染：平台、功能、语言 ----------

function platformLabel(tg) {
  if (tg.kind === 'docker') {
    return t('dockerChip')
  }
  if (tg.kind === 'fpk') {
    return tg.platform === 'x86' ? 'x86' : 'ARM'
  }
  if (tg.goos !== 'linux') {
    const os = { windows: 'Windows', darwin: 'macOS', freebsd: 'FreeBSD' }[tg.goos] || tg.goos
    const arch = tg.goos === 'darwin' && tg.goarch === 'arm64' ? (state.ui === 'en' ? 'Apple silicon' : state.ui === 'zh-TW' ? 'Apple 晶片' : 'Apple 芯片') : ARCH[tg.goarch] || tg.goarch
    return `${os} ${arch}`
  }
  return ARCH[tg.goarch] || tg.goarch
}

function targetGroup(tg) {
  if (tg.kind === 'docker') {
    return 'docker'
  }
  if (tg.kind === 'fpk') {
    return 'fnos'
  }
  if (tg.kind === 'openwrt') {
    return 'openwrt'
  }
  return tg.goos === 'linux' ? 'linux' : 'other'
}

const targetName = (tg) => `${t('group.' + targetGroup(tg))} ${platformLabel(tg)}`

function renderPlatforms() {
  $('platforms').replaceChildren(
    // Docker 是用户最多的安装方式，放在最前面
    ...['docker', 'linux', 'openwrt', 'fnos', 'other'].map((g) =>
      el(
        'div',
        { class: 'platform-group', role: 'group', 'aria-label': t('group.' + g) },
        el('span', {}, t('group.' + g)),
        el(
          'div',
          { class: 'chips' },
          state.manifest.targets
            .filter((tg) => targetGroup(tg) === g)
            .map((tg) =>
              el(
                'button',
                {
                  type: 'button',
                  class: 'chip',
                  'data-target': tg.id,
                  'aria-pressed': String(state.targets.has(tg.id)),
                  onclick: (e) => {
                    const on = !state.targets.has(tg.id)
                    on ? state.targets.add(tg.id) : state.targets.delete(tg.id)
                    e.currentTarget.setAttribute('aria-pressed', String(on))
                    renderSummary()
                  },
                },
                el('span', { html: ICON_CHECK, style: 'display:contents' }),
                platformLabel(tg),
              ),
            ),
        ),
      ),
    ),
  )
}

function presets() {
  const optional = state.manifest.modules.filter((m) => !m.core).map((m) => m.id)
  return [{ id: 'all', title: null, modules: optional }, ...(state.manifest.presets || [])]
}

function renderPresets() {
  const sel = [...state.modules].sort().join(',')
  $('presets').replaceChildren(
    ...presets().map((p) =>
      el(
        'button',
        { type: 'button', class: 'preset', 'data-preset': p.id, 'aria-pressed': String([...p.modules].sort().join(',') === sel), onclick: () => applyPreset(p.modules) },
        p.title ? pick(p.title) : t('preset.all'),
      ),
    ),
  )
}

const groupColor = (gid) => `var(--g-${gid})`

function renderModules() {
  const m = state.manifest
  // 重新渲染会替换节点，记下键盘焦点所在的模块，渲染后放回去
  const focused = document.activeElement?.closest?.('[data-module]')?.dataset.module
  $('modules').replaceChildren(
    ...m.groups.map((g) =>
      el(
        'div',
        { class: 'mgroup', style: `--gc:${groupColor(g.id)}` },
        el('h3', {}, pick(g.title)),
        el(
          'div',
          { class: 'mgrid' },
          m.modules
            .filter((x) => x.group === g.id)
            .map((x) => {
              const on = x.core || state.modules.has(x.id)
              const tag = x.core ? el('span', { class: 'tag core' }, t('core')) : state.auto.has(x.id) && on ? el('span', { class: 'tag dep' }, t('dep')) : null
              return el(
                'label',
                {
                  class: `mod${on ? ' on' : ''}${x.core ? ' locked' : ''}`,
                  'data-module': x.id,
                  onmouseenter: () => highlightSeg(x.id, true),
                  onmouseleave: () => highlightSeg(x.id, false),
                },
                el('input', { type: 'checkbox', checked: on, disabled: x.core, onchange: (e) => toggleModule(x.id, e.target.checked) }),
                el('span', { class: 'box', html: ICON_CHECK }),
                el('span', {}, el('span', { class: 'mod-title' }, pick(x.title)), tag, el('span', { class: 'mod-desc' }, pick(x.desc))),
                el('span', { class: 'mod-size' }, x.core || !x.sizeKB ? '' : `${mb(x.sizeKB)} MB`),
              )
            }),
        ),
      ),
    ),
  )
  if (focused) {
    $('modules').querySelector(`[data-module="${focused}"] input`)?.focus({ preventScroll: true })
  }
}

function renderLanguages() {
  $('languages').replaceChildren(
    ...state.manifest.languages.map((l) =>
      el(
        'label',
        { class: 'lang-opt', 'data-lang': l.id },
        el('input', {
          type: 'radio',
          name: 'lang',
          value: l.id,
          checked: state.lang === l.id,
          onchange: () => {
            state.lang = l.id
            renderSummary()
          },
        }),
        el('span', { class: 'lang-name' }, pick(l.title)),
        el('span', { class: 'lang-save' }, l.sizeKB ? `−${mb(l.sizeKB)} MB` : ''),
      ),
    ),
  )
}

// ---------- 存储条与汇总 ----------

// segments 返回存储条的各段：核心、每个可选模块、其他语言，宽度以完整版为 100%
function segments() {
  const m = state.manifest
  const optional = m.modules.filter((x) => !x.core)
  const langMax = Math.max(...m.languages.map((l) => l.sizeKB || 0))
  const langNow = langMax - (m.languages.find((l) => l.id === state.lang)?.sizeKB || 0)
  const coreKB = m.baseSizeKB - optional.reduce((n, x) => n + (x.sizeKB || 0), 0) - langMax
  const order = m.groups.map((g) => g.id)
  const list = [{ id: '__core', kb: coreKB, on: true, color: 'var(--g-core)', title: t('coreSeg') }]
  for (const x of [...optional].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))) {
    if (x.sizeKB) {
      list.push({ id: x.id, kb: x.sizeKB, on: state.modules.has(x.id), color: groupColor(x.group), title: pick(x.title) })
    }
  }
  list.push({ id: '__lang', kb: langMax, on: langNow > 0, shownKB: langNow, color: 'var(--g-lang)', title: t('langSeg') })
  return list
}

function estimateKB() {
  return segments().reduce((n, s) => n + (s.on ? (s.shownKB ?? s.kb) : 0), 0)
}

function renderStorage() {
  const box = $('storage')
  const base = state.manifest.baseSizeKB
  const segs = segments()
  const first = !state.segsReady
  if (first) {
    box.replaceChildren(
      ...segs.map((s) =>
        el('span', {
          class: 'seg',
          'data-seg': s.id,
          style: `--gc:${s.color};width:0`,
          onmouseenter: (e) => showTip(e.currentTarget, s.id),
          onmouseleave: hideTip,
        }),
      ),
    )
    state.segsReady = true
  }
  segs.forEach((s, i) => {
    const node = box.querySelector(`[data-seg="${s.id}"]`)
    const kb = s.shownKB ?? s.kb
    const width = s.on ? `max(3px, calc(${((kb / base) * 100).toFixed(3)}% - 2px))` : '0px'
    node.classList.toggle('off', !s.on)
    node.dataset.kb = s.on ? kb : 0
    if (first && !reduceMotion.matches) {
      // 首次出现时各段依次填满，之后的变化不带延迟
      node.style.transitionDelay = `${120 + i * 28}ms`
      requestAnimationFrame(() => requestAnimationFrame(() => (node.style.width = width)))
      setTimeout(() => (node.style.transitionDelay = ''), 1400)
    } else {
      node.style.width = width
    }
  })
  box.setAttribute('aria-label', `${mb(estimateKB())} / ${mb(base)} MB`)
  const groups = state.manifest.groups.filter((g) => segs.some((s) => s.color === groupColor(g.id)))
  $('legend').replaceChildren(
    el('li', { style: '--gc:var(--g-core)' }, t('coreSeg')),
    ...groups.map((g) => el('li', { style: `--gc:${groupColor(g.id)}` }, pick(g.title))),
    el('li', { style: '--gc:var(--g-lang)' }, t('langSeg')),
  )
}

function showTip(node, id) {
  const s = segments().find((x) => x.id === id)
  const tip = $('storage-tip')
  const card = node.closest('.pack-card')
  const r = node.getBoundingClientRect()
  const c = card.getBoundingClientRect()
  tip.textContent = `${s.title} · ${mb(s.shownKB ?? s.kb)} MB`
  tip.style.left = `${r.left - c.left + r.width / 2}px`
  tip.style.top = `${r.top - c.top - 8}px`
  tip.hidden = false
}

function hideTip() {
  $('storage-tip').hidden = true
}

function highlightSeg(id, on) {
  $('storage').querySelector(`[data-seg="${id}"]`)?.classList.toggle('hl', on)
}

// tweenNumber 让体积数字平滑滚动到新值
function tweenNumber(to) {
  const from = state.shownKB ?? to
  state.shownKB = to
  const nodes = [$('size'), $('dock-size')]
  cancelAnimationFrame(tweenNumber.raf)
  if (reduceMotion.matches || from === to) {
    nodes.forEach((n) => (n.textContent = mb(to)))
    return
  }
  const start = performance.now()
  const step = (now) => {
    const p = Math.min(1, (now - start) / 450)
    const v = from + (to - from) * (1 - Math.pow(1 - p, 3))
    nodes.forEach((n) => (n.textContent = mb(v)))
    if (p < 1) {
      tweenNumber.raf = requestAnimationFrame(step)
    }
  }
  tweenNumber.raf = requestAnimationFrame(step)
}

function selectedTargets() {
  return state.manifest.targets.filter((tg) => state.targets.has(tg.id))
}

function renderSummary() {
  const m = state.manifest
  const base = m.baseSizeKB
  const kb = estimateKB()
  tweenNumber(kb)
  const saved = base - kb
  $('delta').textContent = saved > 64 ? t('sizeDelta', { mb: mb(saved), pct: Math.round((saved / base) * 100) }) : t('sizeFull')
  renderStorage()
  $('sum-modules').textContent = t('modulesCount', { n: state.modules.size })
  const targets = selectedTargets()
  $('sum-platforms').textContent = targets.length ? targets.map(targetName).join(t('sep')) : t('noPlatform')
  $('sum-lang').textContent = pick(m.languages.find((l) => l.id === state.lang)?.title)
  const note = $('note')
  note.textContent = state.note
  note.hidden = !state.note
  $('submit').disabled = targets.length === 0 || $('submit').classList.contains('busy')
  $('submit-hint').textContent = targets.length ? t('readyHint', { n: targets.length }) : t('needPlatform')
  $('dock-sub').textContent = state.note || (targets.length ? t('readyHint', { n: targets.length }) : t('needPlatform'))
  renderPresets()
}

function render() {
  renderPlatforms()
  renderModules()
  renderLanguages()
  renderSummary()
  if (state.jobData) {
    showJob(state.jobData)
  }
}

// ---------- 移动端抽屉 ----------

function openPack(open) {
  $('pack').classList.toggle('open', open)
  $('backdrop').hidden = !open
  if (open) {
    $('pack-close').focus({ preventScroll: true })
  }
}

// ---------- 提交与进度 ----------

function selection() {
  return {
    version: state.version,
    modules: state.manifest.modules.filter((m) => state.modules.has(m.id)).map((m) => m.id),
    lang: state.lang,
    targets: state.manifest.targets.map((tg) => tg.id).filter((id) => state.targets.has(id)),
  }
}

function shareURL() {
  const s = selection()
  const q = new URLSearchParams({ version: s.version, modules: s.modules.join(','), lang: s.lang, targets: s.targets.join(',') })
  return `${location.origin}${location.pathname}?${q}`
}

async function submit() {
  const err = $('submit-error')
  const btn = $('submit')
  err.hidden = true
  const sel = selection()
  // 先请求通知权限，构建完成时提醒（用户拒绝也不影响构建）
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => undefined)
  }
  btn.classList.add('busy')
  btn.disabled = true
  btn.querySelector('.primary-label').textContent = t('pack.submitting')
  try {
    const data = await api('/api/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sel) })
    state.job = { ...sel, submittedAt: Date.now(), notified: false }
    localStorage.setItem(KEY.job, JSON.stringify(state.job))
    state.prev = {}
    showJob(data)
    $('job').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'nearest' })
  } catch (e) {
    err.textContent = t('submitFailed', { error: e.message })
    err.hidden = false
  } finally {
    btn.classList.remove('busy')
    btn.querySelector('.primary-label').textContent = t('pack.submit')
    btn.disabled = state.targets.size === 0
  }
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

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// pullBox 显示定制镜像的拉取命令与复制按钮
function pullBox(image) {
  const cmd = `docker pull ${image}`
  return el(
    'div',
    { class: 'pull' },
    el('code', { class: 'pull-cmd', title: cmd }, cmd),
    el(
      'button',
      {
        type: 'button',
        class: 'pull-copy',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(cmd)
            toast(t('pull.copied'))
          } catch {
            prompt('', cmd)
          }
        },
      },
      t('pull.copy'),
    ),
    el('p', { class: 'pull-note' }, t('pull.arch')),
  )
}

// fileLabel 显示去掉组合键的文件名；空间不够时省略前半部分，扩展名始终完整显示（ipk 与 apk 要能区分）
function fileLabel(name) {
  const short = name.replace(/_[0-9a-f]{12}_/, '_')
  const m = /^(.*?)(\.(?:tar\.gz|[a-z]+))$/.exec(short)
  return el('span', { class: 'file-name' }, el('span', { class: 'file-base' }, m ? m[1] : short), m ? el('span', { class: 'file-ext' }, m[2]) : null)
}

function startedAt(s) {
  return s.startedAt ? Date.parse(s.startedAt) : state.job?.submittedAt || Date.now()
}

function showJob(data) {
  clearTimeout(state.timer)
  state.jobData = data
  $('job').hidden = false
  const items = data.targets.map((s) => {
    const tg = state.manifest.targets.find((x) => x.id === s.target)
    const pill = el('span', { class: `pill ${s.state}`, 'data-state': s.state }, t(s.image ? 'state.pull' : 'state.' + s.state))
    const body = []
    if (s.state === 'done' && s.image) {
      body.push(pullBox(s.image))
    } else if (s.state === 'done') {
      body.push(
        el(
          'ul',
          { class: 'files' },
          s.files.map((f) =>
            // 显示名去掉 12 位组合键以便看清平台与扩展名，完整文件名放在提示与下载名中
            el('li', {}, el('a', { class: 'file', href: f.url, download: f.name, title: f.name }, el('span', { html: ICON_DOWNLOAD, style: 'display:contents' }), fileLabel(f.name), el('span', { class: 'file-size' }, `${mb(f.size / 1024)} MB`))),
          ),
        ),
      )
    } else if (s.state === 'building' || s.state === 'queued') {
      body.push(el('div', { class: `progress ${s.state}` }))
      body.push(el('div', { class: 'job-meta', 'data-started': startedAt(s) }, t('elapsed', { t: fmtElapsed(Date.now() - startedAt(s)) }), s.runUrl ? ' · ' : '', s.runUrl ? el('a', { href: s.runUrl, target: '_blank', rel: 'noopener' }, t('viewLog')) : null))
    } else if (s.state === 'failed' && s.runUrl) {
      body.push(el('div', { class: 'job-meta' }, el('a', { href: s.runUrl, target: '_blank', rel: 'noopener' }, t('viewLog'))))
    }
    const li = el('li', { class: 'job-item', 'data-job': s.target }, el('div', { class: 'job-row' }, el('span', {}, tg ? targetName(tg) : s.target), pill), body)
    // 刚从构建中变为完成时迸出一圈小方块
    if (s.state === 'done' && state.prev[s.target] && state.prev[s.target] !== 'done') {
      requestAnimationFrame(() => burst(pill))
    }
    state.prev[s.target] = s.state
    return li
  })
  $('job-list').replaceChildren(...items)
  const pending = data.targets.some((s) => ['building', 'queued', 'idle'].includes(s.state))
  const failed = data.targets.some((s) => s.state === 'failed')
  $('job-hint').textContent = pending ? t('jobHint') : failed ? t('jobFailed') : t('jobDone')
  clearInterval(state.tick)
  if (pending) {
    // 每秒刷新已用时间，每隔 POLL_MS 查询一次进度
    state.tick = setInterval(() => {
      document.querySelectorAll('[data-started]').forEach((n) => {
        n.firstChild.textContent = t('elapsed', { t: fmtElapsed(Date.now() - Number(n.dataset.started)) })
      })
    }, 1000)
    state.timer = setTimeout(poll, POLL_MS)
    return
  }
  const done = data.targets.filter((s) => s.state === 'done').length
  if (state.job && !state.job.notified && done > 0) {
    state.job.notified = true
    localStorage.setItem(KEY.job, JSON.stringify(state.job))
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(t('notifyTitle'), { body: t('notifyBody', { n: done }), icon: 'favicon.svg' })
    }
  }
}

function burst(anchor) {
  if (reduceMotion.matches) {
    return
  }
  const host = anchor.closest('.job-item')
  if (!host) {
    return
  }
  const a = anchor.getBoundingClientRect()
  const h = host.getBoundingClientRect()
  const colors = ['--g-network', '--g-tunnel', '--g-web', '--g-storage', '--g-tools', '--accent']
  for (let i = 0; i < 14; i++) {
    const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.4
    const dist = 28 + Math.random() * 26
    const p = el('span', {
      class: 'spark',
      style: `left:${a.left - h.left + a.width / 2}px;top:${a.top - h.top + a.height / 2}px;background:var(${colors[i % colors.length]});--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px;--rot:${Math.random() * 360}deg`,
    })
    host.append(p)
    setTimeout(() => p.remove(), 1000)
  }
}

// ---------- 启动 ----------

function init() {
  applyStaticText()
  renderThemeButtons()
  document.querySelectorAll('[data-theme-value]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeValue, b)))
  $('ui-lang').addEventListener('change', (e) => {
    state.ui = e.target.value
    localStorage.setItem(KEY.ui, state.ui)
    applyStaticText()
    if (state.manifest) {
      state.segsReady = false
      render()
    } else if ($('load-error').dataset.msg) {
      $('load-error').hidden = true
      loadVersions()
    }
  })
  $('version').addEventListener('change', (e) => loadManifest(e.target.value, false))
  $('submit').addEventListener('click', submit)
  $('share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareURL())
      toast(t('pack.copied'))
    } catch {
      prompt('', shareURL())
    }
  })
  $('dock-open').addEventListener('click', () => openPack(true))
  $('dock-go').addEventListener('click', () => openPack(true))
  $('pack-close').addEventListener('click', () => openPack(false))
  $('backdrop').addEventListener('click', () => openPack(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('pack').classList.contains('open')) {
      openPack(false)
    }
  })
  narrow.addEventListener('change', () => openPack(false))
  // 开头区域的点阵跟随光标亮起（只在有鼠标的设备上）
  const intro = document.querySelector('.intro')
  if (matchMedia('(hover: hover)').matches && !reduceMotion.matches) {
    intro.addEventListener('pointermove', (e) => {
      const r = intro.getBoundingClientRect()
      intro.style.setProperty('--mx', `${e.clientX - r.left + 40}px`)
      intro.style.setProperty('--my', `${e.clientY - r.top}px`)
      intro.classList.add('lit')
    })
    intro.addEventListener('pointerleave', () => intro.classList.remove('lit'))
  }
  loadVersions()
}

init()
