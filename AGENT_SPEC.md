# vllm-pet — 协作契约（AGENT_SPEC）

## 用户目标

实现一个跨平台桌面宠物软件：启动时可配置 vLLM 推理服务的 API 地址；启动后定期轮询服务状态
（`/health` + `/metrics`），根据状态切换桌宠形象与动画：空闲、推理中（按负载强度分 3 档动画/特效）、
离线、连接中；长时间空闲会睡觉。形象与动画支持自定义（皮肤系统）。默认提供一只简约可爱的机器人。
要求支持各操作系统与不同 CPU 架构（Windows/macOS/Linux × x64/arm64，通过 electron-builder + CI 产出）。

## 技术栈（已定，勿改）

- Electron（`"type": "module"`，ESM 主进程）+ Vite（vanilla，无前端框架）+ 原生 ES Modules。
- 包管理器：npm。根 `package.json` 已固定，**任何 worker 不得修改依赖与 scripts**。
- 机器人用内联 SVG + CSS 动画渲染（矢量、轻量、易换肤），粒子特效用 DOM/CSS（不用 canvas 也可）。
- 轮询在 **Electron 主进程**执行（Node fetch，无 CORS 问题）；浏览器预览页使用 Mock 数据源。

## 目录布局与所有权

```
package.json / vite.config.js / .gitignore / AGENT_SPEC.md   ← 基线（勿动）
index.html              ← Worker A：浏览器预览/演示页（npm run dev 打开它）
pet.html                ← Worker A：桌宠窗口页面（Electron 加载 dist/pet.html）
src/renderer/**         ← Worker A 独有（UI、动画、状态机、皮肤、预览页逻辑）
src/shared/status-core.js ← Worker A 独有（纯函数，零依赖零副作用，Node 与浏览器通用）
tests/**                ← Worker A（node --test）
src/main/**             ← Worker B 独有（Electron 主进程、preload、托盘、配置存储、轮询服务）
scripts/**              ← Worker B（dev-desktop.mjs、smoke.mjs）
build/icons/**          ← Worker B（应用图标，用 Python Pillow 生成 PNG）
electron-builder.yml    ← Worker B
.github/workflows/**    ← Worker B（跨平台构建 CI）
README.md               ← 主代理最后统一撰写（两个 worker 都不要写）
```

worker 不得编辑对方路径。合并顺序：先 renderer（agent/renderer），再 desktop（agent/desktop）。

## 共享契约一：src/shared/status-core.js（Worker A 编写，Worker B 只读引用）

纯 ESM、零依赖、零副作用、不得访问 window/document/process。必须导出：

- `parsePrometheusMetrics(text) -> { running: number, waiting: number, cacheUsage: number|null }`
  - 解析 vLLM `/metrics` Prometheus 文本。匹配（含标签变体）：
    `vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:gpu_cache_usage_perc`。
  - 忽略 `# HELP`/`# TYPE` 注释行；同名指标带不同 label 时求和（cacheUsage 取最后一个值）。
  - 文本缺失指标时对应字段为 0（cacheUsage 为 null）。解析失败不得抛异常，返回全零对象。
- `deriveState({ healthOk, metrics, prevState }) -> { state, intensity }`
  - `healthOk=false` → `{ state: 'offline', intensity: 0 }`
  - `healthOk=true` 且 `metrics=null` → `{ state: 'idle', intensity: 0 }`（老版本无 /metrics 时降级为仅存活检测）
  - 有 metrics：`running+waiting >= 16` 或 `cacheUsage >= 0.85` → `busy` intensity 3；
    `>= 4` → intensity 2；`>= 1` → intensity 1；否则 `idle` intensity 0。
  - 阈值允许通过第二个可选参数 `thresholds = { light: 1, medium: 4, heavy: 16, cacheHeavy: 0.85 }` 覆盖。

## 共享契约二：状态快照（StatusSnapshot，主进程 → 渲染层）

```json
{
  "state": "offline | connecting | idle | busy",
  "intensity": 0,
  "running": 0,
  "waiting": 0,
  "cacheUsage": null,
  "latencyMs": null,
  "models": ["..."],
  "error": null,
  "updatedAt": 0
}
```

- `connecting`：尚未拿到任何一次成功的健康检查（启动初期 / 重连中）。
- 渲染层映射：`offline`→灰暗+感叹号气泡；`connecting`→天线扫描；`idle`→平静呼吸眨眼，
  连续空闲 `config.idleSleepMinutes` 后进入睡觉（Zzz）；`busy` 按 intensity 1/2/3 三档加速与特效
  （1=天线脉冲+轻快摆动，2=加速+汗滴+蒸汽，3=极速+蒸汽喷射+屏幕光闪烁+速度线）。
- busy → idle 转换时播放一次"完成"开心弹跳+闪光，再回平静。

## 共享契约三：IPC（preload 暴露 `window.vllmPet`）

Worker B 在 `src/main/preload.cjs`（CommonJS、contextIsolation）暴露，Worker A 按此消费：

```ts
window.vllmPet = {
  getConfig(): Promise<Config>
  saveConfig(patch: Partial<Config>): Promise<Config>
  onStatus(cb: (s: StatusSnapshot) => void): () => void   // 主进程每次轮询后推送
  listSkins(): Promise<Array<{ name: string, displayName: string, builtin: boolean }>>
  loadSkin(name: string): Promise<object | null>          // 返回 skin.json 解析结果+内联资源，见契约四
  setClickThrough(v: boolean): void
  setAlwaysOnTop(v: boolean): void
  dragStart(): void; dragEnd(): void                      // 主进程用 screen.getCursorScreenPoint 跟手拖动
  quit(): void
  platform: string                                        // process.platform
}
```

渲染层在浏览器（无 `window.vllmPet`）必须优雅降级：预览页用 `MockStatusProvider`
（手动切换状态/强度 + 可选"真实直连"模式，fetch 用户填的 API，CORS 失败时提示这是浏览器限制）。
渲染层所有 IPC 访问必须封装在 `src/renderer/status/` 的 provider 里，UI 代码不直接碰 `window.vllmPet`。

## 共享契约四：配置（Config）与皮肤

Config（主进程存于 `app.getPath('userData')/config.json`，默认值如下，saveConfig 做深合并）：

```json
{
  "apiBase": "",
  "apiKey": "",
  "pollIntervalMs": 2000,
  "metricsPath": "/metrics",
  "healthPath": "/health",
  "thresholds": { "light": 1, "medium": 4, "heavy": 16, "cacheHeavy": 0.85 },
  "skin": "default-robot",
  "idleSleepMinutes": 10,
  "window": { "alwaysOnTop": true, "clickThrough": false, "scale": 1, "opacity": 1, "x": null, "y": null }
}
```

- `apiBase` 为空 = 首次运行：桌宠旁弹出气泡式设置表单（URL、轮询间隔、API Key），保存后立即开始轮询。
  设置面板随时可从托盘菜单或右键宠物打开（Worker A 做 UI，Worker B 做托盘入口与 IPC）。

皮肤（Worker A 定义完整 schema，以下字段名固定，Worker B 的 `loadSkin` 按此读取用户皮肤目录）：

- 内置皮肤位于 `src/renderer/skins/default-robot/`，通过 Vite `?raw` 内联打包（浏览器/桌面均可用）。
- 用户皮肤位于 `<userData>/skins/<name>/skin.json`（+ 可选 SVG/PNG 资源文件）。
  `loadSkin(name)` 返回 `{ ...skinJson, assets: { [fileName]: dataUrl } }`，资源读不到时字段省略。
- skin.json 固定顶层字段：`{ name, displayName, version, palette: {...}, animations: {...} }`。
- Worker A 在 `src/renderer/skins/README.md` 写清自定义皮肤教程（字段、资源、放置路径）。

## 设计基调（Worker A 遵循）

默认机器人名"小V"。悬浮无腿机器人：圆角矩形头（深色屏幕脸+发光眼睛）、小身体、短手臂、
头顶天线（端部灯球，是状态指示灯）、底部悬浮阴影。配色：薄荷绿机身 (#7fd8c9 系)、
深色脸屏 (#12232b)、青色发光眼 (#7ef0ff)、珊瑚橙点缀 (#ff8a7a)。整体简约 Q 弹，
动画用 CSS keyframes + 状态 class 切换，摆动/呼吸/眨眼要有"果冻感"（cubic-bezier 回弹）。
窗口约 240×280（可随 config.window.scale 缩放），pet.html 背景全透明。

## 验证命令

- Worker A：`npm run build`（Vite 构建通过）；`npm test`（tests/status-core.test.mjs 全绿，
  覆盖：注释行、带 label 指标求和、缺指标、各阈值分档、offline/connecting 推导）。
- Worker B：`npm run build` 后 `node scripts/smoke.mjs` 退出码 0
  （启动 Electron 隐藏窗口加载 dist/pet.html，2.5s 后 capturePage 存 `smoke-pet.png` 并退出）。
  注意 smoke 场景下主进程不得弹设置窗/不得轮询外网（用环境变量 VLLM_PET_SMOKE=1 控制，配置用临时目录）。
- 两边都不得引入新的 npm 依赖（除基线已装的 vite / electron / electron-builder）。

## 合并与集成（主代理负责）

1. 合并 agent/renderer → main，再合并 agent/desktop → main（路径不重叠，预期无冲突）。
2. 主仓库 npm install → npm test → npm run build → node scripts/smoke.mjs → 查看 smoke-pet.png。
3. 主代理撰写 README.md（安装、运行、配置、皮肤自定义、跨平台打包/CI 说明）。
