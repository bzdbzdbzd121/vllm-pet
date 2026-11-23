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
 * 状态机（阶段 0 裁决 §2.3）：
 *   [stopped] --(唤起 start)--> [会话中：seed + 每 intervalMs 采样]
 *   会话中：
 *     - 渲染层上报「收到带坐标的转发事件」→ 事件源取得权威，轮询停止（稳态零轮询）
 *     - 采样出现 ≥2 个不同读数 → 轮询取得权威，之后只在变化时推送
 *     - 都没有 → 种子（临时候选）在 1.5s 后撤回并记一次日志 → 保持 fail-closed
 *     - 采样抛错/非有限 → 清状态 + 停轮询 + 只记一次日志（永不抛到未捕获异常）
 *
 * 关于「决策窗」：本实现不设独立的 400ms 窗，而是把它折叠进「种子有效期 1.5s + 存活证据阈值」——
 * 两者共同决定「多久没有证据就 fail-closed」。刻意**不**在窗口到期时停止采样：停了以后即使
 * 数据源恢复也再也拿不到「≥2 个不同读数」，等于把一次瞬态故障变成永久失效。
 */
import { DEFAULT_HOVER_FADE } from '../shared/hover-fade.js'

/** 采样间隔：100ms（淡化过渡 160ms，够用且比 50ms 省电） */
export const HOVER_INTERVAL_MS = 100
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
 */
export function createHoverMonitor({
  getCursor,
  getBounds,
  send,
  supported = false,
  intervalMs = HOVER_INTERVAL_MS,
  seedTtlMs = HOVER_SEED_TTL_MS,
  now = () => Date.now(),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
  log = () => {},
  onDegrade = () => {}
} = {}) {
  let sessionActive = false // 会话是否还在（事件源接管后依然算在会话内）
  let running = false // 轮询定时器是否在跑（E3/E6/E7 的「运行中/停止」）
  let timer = null
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

  const emit = (payload, force = false) => {
    const key = payload ? `${payload.nx},${payload.ny}` : 'null'
    if (!force && key === lastPayloadKey) return
    lastPayloadKey = key
    lastPayload = payload
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

  const resetSession = () => {
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
    sessionActive = false
    source = null
    seedActive = false
    emit(null)
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
    if (source === 'poller') {
      emit(payload)
      return
    }
    if (source === 'events') return // 事件源独占（正常情况下定时器已停）
    // 未获证：种子到期就撤回一次，之后保持 fail-closed（不做任何自发状态改变）
    if (seedActive) {
      if (now() - seedAt < seedTtlMs) return
      seedActive = false
      if (!loggedSeedExpired) {
        loggedSeedExpired = true
        try {
          log(`[hover-monitor] ${Math.round(seedTtlMs)}ms 内没有任何来源出示存活证据，撤回候选状态（fail-closed）`)
        } catch { /* ignore */ }
      }
      emit(null)
      return
    }
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
      return true
    },

    /** 结束会话：停轮询 + 清状态（幂等；未在会话中则什么都不发） */
    stop() {
      const had = sessionActive || running
      clearTimer()
      sessionActive = false
      source = null
      seedActive = false
      degraded = false // 允许下次会话重试
      readings.clear()
      lastReadingKey = null
      if (had) emit(null)
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
      source = 'events'
      seedActive = false
      clearTimer() // 事件源稳态零轮询
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
      emit(payload, true)
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
        cursor: lastPayload,
        /** 渲染层判定用的不透明度参考（配置里另有一份，这里只做展示/调试） */
        opacity: DEFAULT_HOVER_FADE.opacity
      }
    }
  }
}
