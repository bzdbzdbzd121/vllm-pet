/**
 * hover-monitor.js — 穿透模式下的「系统光标 → 归一化坐标」监控（纯逻辑，依赖全注入）
 *
 * 背景（阶段 0 裁决 §2）：窗口一旦「忽略鼠标事件」，Linux 上一个事件都收不到、且穿透模式下
 * `getCursorScreenPoint()` 读数会冻结；「读数不變」既可能是光标停着，也可能是读数卡住。
 * 单个信号无法自证，所以这里只做两件事：**要求来源先出示存活证据**，**拿不到权威就 fail-closed**。
 *
 * 本文件不含平台判断：`supported` 由 main.js 传入（Linux 恒 false → 零行为）。
 * 也不碰 Electron：光标/窗口框/发送/时钟/定时器全部注入，便于在 Node 里跑 E1–E7。
 *
 * 状态机（阶段 0 裁决 §2.3，v0.3.3 修订「超时不得清状态」）：
 *   [stopped] --(唤起 start)--> [会话中：seed + 每 intervalMs 采样]
 *   会话中：
 *     - 渲染层上报「收到带坐标的转发事件」→ 事件源取得权威，轮询停止（稳态零轮询）
 *     - 采样出现 ≥2 个不同读数 → 轮询取得权威，之后只在变化时推送
 *     - 都没有 → 种子只是「本会话的一次有效观察」，**不按时间撤回**；仍按变化推送，
 *       过了 seedTtlMs 只记一次「未获证」诊断日志（v0.3.2 曾在这里 emit(null)，导致
 *       手停在宠物上 1.5s 后淡化自己消失）
 *     - 采样读到窗口外 → 推 null（**这是唯一的「无事件清状态」依据**：明确的离开）
 *     - 事件源接管后仍保留一个低频兜底采样（`HOVER_GUARD_INTERVAL_MS`）**只判「光标是否在窗口外」**：
 *       命中矩形贴着窗口底边（底部间距 0），光标向下方移出时窗口内没有「区外」位置可派发 move，
 *       `pointerleave` 在穿透窗口上又不保证送达 → 不兜底就会永久残留（Windows 实测只坏在下方）
 *     - 采样抛错/非有限 → 清状态 + 停轮询 + 只记一次日志（永不抛到未捕获异常）
 *
 * 清状态的完整清单（除此之外没有任何路径会 emit(null)）：采样失败、读到窗口外、
 * 宿主 stop()（hide/minimize/lock/关穿透/关功能/退出）、握手 sync() 时按当下光标判到窗外。
 *
 * 关于「决策窗」：本实现不设独立的 400ms 窗，而是把它折叠进「存活证据阈值 + seedTtlMs 诊断」——
 * 刻意**不**在窗口到期时停止采样：停了以后即使数据源恢复也再也拿不到「≥2 个不同读数」，
 * 等于把一次瞬态故障变成永久失效。
 */
import { DEFAULT_HOVER_FADE } from '../shared/hover-fade.js'

/** 采样间隔：100ms（淡化过渡 160ms，够用且比 50ms 省电） */
export const HOVER_INTERVAL_MS = 100
/**
 * 事件源接管后的「窗外兜底采样」间隔（ms）。事件源会话里轮询是停的（稳态零轮询），
 * 但命中矩形被裁剪到容器 → 底部间距为 0（1 档 280..280、0.6 档 168..168、2 档仅 4.2px），
 * 「向下走出矩形但仍在窗口内」这段路根本不存在；上/左/右靠窗口内的 pointermove 就能判出区外，
 * 下方只能靠 pointerleave，而穿透窗口（forward:true）不保证派发 leave →
 * 既无事件也无采样 → 状态永久残留（Windows 实测：上/左/右恢复、下方不恢复）。
 * 这个兜底采样**只做一件事**：读到「光标在窗口外」就清状态。绝不推坐标、绝不改权威、绝不影响窗内静止。
 */
export const HOVER_GUARD_INTERVAL_MS = 300
/** 种子（未获证的候选状态）有效期：到期撤回，最坏结果是「不淡化」而不是「卡在淡化」 */
export const HOVER_SEED_TTL_MS = 1500
/** 存活证据阈值：同一会话内至少这么多个不同读数才承认轮询源活着 */
export const HOVER_MIN_DISTINCT_READINGS = 2

/**
 * 是否该运行穿透悬停监控。
 * `supported` 是平台闸门（main.js 里只有 win32/darwin 为真）；Linux 恒 false → 零行为。
 * @param {{supported?: boolean, clickThrough?: boolean, enabled?: boolean, visible?: boolean,
 *          minimized?: boolean, locked?: boolean, smoke?: boolean}} state
 */
export function shouldRunHoverMonitor({
  supported = false,
  clickThrough = false,
  enabled = false,
  visible = false,
  minimized = false,
  locked = false,
  smoke = false
} = {}) {
  if (!supported || smoke) return false
  if (!clickThrough || !enabled) return false
  if (!visible || minimized) return false
  if (locked) return false
  return true
}

const isPoint = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
const isBox = (b) => !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number(b.width) > 0 && Number(b.height) > 0

/**
 * 创建监控器。
 * @param {object} opts
 * @param {() => {x:number,y:number}} opts.getCursor 屏幕坐标（DIP，可为负/多显示器）
 * @param {() => ({x:number,y:number,width:number,height:number}|null)} opts.getBounds 窗口内容区（DIP）
 * @param {(payload: {nx:number,ny:number}|null) => void} opts.send 推给渲染层
 * @param {boolean} [opts.supported] 平台闸门，false 时全部方法都是空操作
 * @param {number} [opts.intervalMs] 采样间隔
 * @param {number} [opts.seedTtlMs] 种子有效期
 * @param {() => number} [opts.now]
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 * @param {(reason: 'degraded') => void} [opts.onDegrade] 监控自行降级时通知宿主（渲染层回到指针模式）
 * @param {(msg: string) => void} [opts.debug] 诊断日志（VLLM_PET_DEBUG_HOVER=1 时由 main.js 注入；默认 null）
 */
export function createHoverMonitor({
  getCursor,
  getBounds,
  send,
  supported = false,
  intervalMs = HOVER_INTERVAL_MS,
  guardIntervalMs = HOVER_GUARD_INTERVAL_MS,
  seedTtlMs = HOVER_SEED_TTL_MS,
  now = () => Date.now(),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
  log = () => {},
  onDegrade = () => {},
  debug = null
} = {}) {
  let sessionActive = false // 会话是否还在（事件源接管后依然算在会话内）
  let running = false // 轮询定时器是否在跑（E3/E6/E7 的「运行中/停止」）
  let timer = null
  let guardTimer = null // 事件源会话里的低频「窗外兜底采样」（不是轮询、不推坐标）
  let guardOutside = false // 当前是否已在「窗外」这段里清过一次（避免每拍都推 null）
  let source = null // null | 'poller' | 'events'
  let seedActive = false
  let seedAt = 0
  let degraded = false
  let loggedSeedExpired = false
  let loggedUpgrade = false
  let failuresLogged = 0
  const readings = new Set() // 决策期内的不同读数（存活证据）
  let lastReadingKey = null
  let lastPayloadKey = null
  let lastPayload = null

  /** 诊断日志（默认关闭：debug 为 null 时零开销） */
  const dbg = (msg) => {
    if (!debug) return
    try {
      debug(msg)
    } catch { /* 日志失败不影响状态机 */ }
  }
  /** 清状态的调用栈（只在 emit(null) 时采集，且仅在 debug 打开时） */
  const clearStack = () => {
    if (!debug) return ''
    const lines = String(new Error('hover:clear').stack || '').split('\n').slice(1, 5)
    return lines.length ? ` | 调用栈${lines.join('')}` : ''
  }

  const emit = (payload, force = false, reason = '') => {
    const key = payload ? `${payload.nx},${payload.ny}` : 'null'
    if (!force && key === lastPayloadKey) return
    lastPayloadKey = key
    lastPayload = payload
    dbg(`emit ${payload ? `nx=${payload.nx.toFixed(3)} ny=${payload.ny.toFixed(3)}` : 'null'}` +
      ` src=${source ?? 'seed'}${reason ? ` reason=${reason}` : ''}` +
      (payload ? '' : clearStack()))
    try {
      send(payload)
    } catch {
      /* 发送失败不影响状态机（窗口可能正在销毁） */
    }
  }

  const clearTimer = () => {
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
    running = false
  }

  const clearGuard = () => {
    if (guardTimer !== null) {
      clearIntervalFn(guardTimer)
      guardTimer = null
    }
  }

  /**
   * 兜底采样：**只判「光标是否在窗口外」**。
   * - 窗内（含读数恒定/冻结）→ 什么都不做（绝不把这里当权威源，也就不可能引回「停下就恢复」）；
   * - 窗口外 → 清一次状态（唯一的副作用）；
   * - 读数不可用（抛错/非有限/bounds 无效）→ 什么都不做（fail-safe：宁可残留，不误清）。
   */
  // 这里刻意不走 sample()：sample() 会算归一化、记存活证据、出错还进 fail()（降级）。
  // 兜底只判「是否在窗口外」，所以直接比 [0,1] 闭区间，异常一律吞掉、不动任何状态。
  const guard = () => {
    if (!sessionActive || source !== 'events') return
    let cursor
    let bounds
    try {
      cursor = getCursor()
      bounds = getBounds()
    } catch {
      return // 兜底采样不进 fail()：它是附加保险，不是权威源
    }
    if (!isPoint(cursor) || !isBox(bounds)) return
    const nx = (cursor.x - bounds.x) / bounds.width
    const ny = (cursor.y - bounds.y) / bounds.height
    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
      guardOutside = false // 回到窗内：下一段「窗外」要重新清一次
      return // 窗内（含读数恒定/冻结）→ 状态保持不变
    }
    if (guardOutside) return // 同一段「窗外」只清一次（不刷屏）
    // 这里必须**强制**发：主进程的 lastPayload 可能已经是 null（握手残值），
    // 而渲染层的淡化是本地 pointermove 建立的 —— 用去重会被吞掉，导致「下方移出」永不恢复。
    guardOutside = true
    dbg(`guard: 光标在窗口外（nx=${nx.toFixed(3)} ny=${ny.toFixed(3)}）→ 清状态`)
    emit(null, true, 'guard-outside')
  }

  const startGuard = () => {
    // 正常路径上到这里 supported 恒 true、degraded 恒 false（reportEvent 已先挡掉）；
    // 保留这两个判断是为了「幂等 + 防御」：重复调用不叠加定时器，降级后不再拉起。
    if (guardTimer !== null || !supported || degraded) return
    guardTimer = setIntervalFn(guard, guardIntervalMs)
    dbg(`guard: start ${guardIntervalMs}ms（仅判窗外）`)
  }

  const resetSession = () => {
    clearGuard()
    guardOutside = false
    source = null
    seedActive = false
    degraded = false
    loggedSeedExpired = false
    loggedUpgrade = false
    readings.clear()
    lastReadingKey = null
    lastPayloadKey = null
    lastPayload = null
  }

  /** 失败即关闭：清状态 + 停轮询 + 只记一次日志，绝不抛到未捕获 */
  const fail = (err) => {
    degraded = true
    if (failuresLogged < 1) {
      failuresLogged += 1
      try {
        log('[hover-monitor] 取不到全局光标，停止穿透悬停（回到指针模式）', err)
      } catch { /* 日志本身失败也不能崩 */ }
    }
    clearTimer()
    clearGuard()
    sessionActive = false
    source = null
    seedActive = false
    dbg(`fail: ${err && err.message ? err.message : String(err)}`)
    emit(null, false, 'fail')
    try {
      onDegrade('degraded')
    } catch { /* 宿主回调失败不影响 */ }
  }

  /**
   * 采样一次；异常/非有限 → fail 并返回 null。
   * `note: false` 用于握手（sync）：只取「此刻」的值，不计入存活证据 —— 否则一次握手采样
   * 就能凑满「≥2 个不同读数」，把权威规则绕过去。
   */
  const sample = ({ note = true } = {}) => {
    let cursor
    let bounds
    try {
      cursor = getCursor()
      bounds = getBounds()
    } catch (err) {
      fail(err)
      return null
    }
    if (!isPoint(cursor)) {
      fail(new Error(`光标坐标无效：${JSON.stringify(cursor)}`))
      return null
    }
    // 存活证据：同一会话里出现足够多的不同读数，才承认这个源「活着」（冻结源永远拿不到）
    if (note) {
      const key = `${cursor.x},${cursor.y}`
      if (key !== lastReadingKey) {
        lastReadingKey = key
        readings.add(key)
        if (!source && readings.size >= HOVER_MIN_DISTINCT_READINGS) {
          source = 'poller'
          seedActive = false
        }
      }
    }
    if (!isBox(bounds)) return null
    const nx = (cursor.x - bounds.x) / bounds.width
    const ny = (cursor.y - bounds.y) / bounds.height
    if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null
    return { nx, ny }
  }

  const tick = () => {
    if (!running) return
    const payload = sample()
    if (!running) return // 这一拍失败已经把定时器停掉了
    if (source === 'events') return // 事件源独占（正常情况下定时器已停）
    // 「未获证」只影响日志，不影响状态：
    // 手停在宠物上时本来就没有任何输入，靠超时 emit(null) 会让淡化在 seedTtlMs 后自己消失
    // （v0.3.2 Windows 穿透缺陷：淡一下就恢复）。这里只记一次诊断，然后照常「变化即推送」。
    if (seedActive && !loggedSeedExpired && now() - seedAt >= seedTtlMs) {
      loggedSeedExpired = true
      try {
        log(`[hover-monitor] ${Math.round(seedTtlMs)}ms 内未取得存活证据（读数恒定/无事件）：保持当前状态，不清状态`)
      } catch { /* ignore */ }
      dbg(`seed unconfirmed after ${Math.round(seedTtlMs)}ms（保持状态）`)
    }
    // 本来就没有状态可清时不要凭空推 null（避免「没淡化过却收到 clear」）
    if (payload === null && lastPayloadKey === null) return
    emit(payload, false, payload ? (source === 'poller' ? 'poller' : 'seed') : 'cursor-outside')
  }

  return {
    /** 开始/继续会话。平台不支持、已降级、已在会话中都直接返回 false/true（幂等） */
    start() {
      if (!supported || degraded) return false
      if (sessionActive) return true // 事件源会话内重复 start 不得把轮询拉起来
      sessionActive = true
      resetSession()
      const payload = sample()
      if (!sessionActive) return false // 首采样就失败
      if (payload) {
        seedActive = true
        seedAt = now()
        emit(payload)
      }
      running = true
      timer = setIntervalFn(tick, intervalMs)
      dbg(`start: seed=${seedActive} payload=${payload ? 'inside' : 'none'}`)
      return true
    },

    /** 结束会话：停轮询 + 清状态（幂等；未在会话中则什么都不发） */
    stop() {
      const had = sessionActive || running
      dbg(`stop: had=${had}`)
      clearTimer()
      clearGuard()
      guardOutside = false
      sessionActive = false
      source = null
      seedActive = false
      degraded = false // 允许下次会话重试
      readings.clear()
      lastReadingKey = null
      if (had) emit(null, false, 'stop')
      return had
    },

    /**
     * 渲染层上报「收到带坐标的指针事件」——事件源的存活证明。
     * 没有坐标的（pointerleave 之类）不算，避免「只转发 leave」的实现拿到假权威。
     */
    reportEvent(info = {}) {
      if (!supported || degraded || !sessionActive) return false
      if (info && info.hasCoords === false) return false
      if (source === 'events') return true
      const wasPoller = source === 'poller'
      dbg(`event: source=${source ?? 'none'} → events`)
      source = 'events'
      seedActive = false
      clearTimer() // 事件源稳态零轮询
      startGuard() // 但保留低频「窗外兜底采样」（只用于发现光标离开窗口）
      if (wasPoller && !loggedUpgrade) {
        loggedUpgrade = true
        try {
          log('[hover-monitor] 收到转发事件，改用事件源并停止轮询')
        } catch { /* ignore */ }
      }
      return true
    },

    /**
     * 页面（重新）加载后握手 / 主动拉取：**单次采样**后强制重发一次当前光标（绕过去重）。
     * 为什么不能直接返回缓存：事件源会话里轮询已经停了（running=false），缓存是上一次推送的残值；
     * 页面重载后若光标已移出窗口，拿残值就会「宠物驻留淡化」，违反 fail-closed。
     * 单次采样不重启定时器、也不计入存活证据。
     * @returns {{nx:number,ny:number}|null} 此刻的光标（会话未开始/采样失败 → null）
     */
    sync() {
      if (!supported || !sessionActive) return null
      // 防御：既没有权威（事件/轮询都没获证）也没有有效种子时，任何读数都是「未确认」的。
      // 冻结源（读数卡住）就落在这里 —— 握手不得把种子值当成状态再点亮一次（fail-closed）。
      if (!source && !seedActive) return null
      const payload = sample({ note: false })
      if (!sessionActive) return null // 采样失败：fail() 已清状态并通知降级
      dbg(`sync: payload=${payload ? 'inside' : 'null'} src=${source ?? 'seed'}`)
      emit(payload, true, 'sync')
      return payload
    },

    isRunning() {
      return running
    },

    getState() {
      return {
        supported,
        running,
        session: sessionActive,
        source,
        degraded,
        guard: guardTimer !== null,
        seed: seedActive,
        seedExpired: loggedSeedExpired,
        cursor: lastPayload,
        /** 渲染层判定用的不透明度参考（配置里另有一份，这里只做展示/调试） */
        opacity: DEFAULT_HOVER_FADE.opacity
      }
    }
  }
}
