# vLLM Pet 开发指南

面向后续开发者（人类或 AI Agent）：读完这份文档即可安全地修改、扩展、验证本项目。
用户向的安装/使用说明在 [README.md](README.md)；初版多代理协作的设计契约（历史文档）在
[AGENT_SPEC.md](AGENT_SPEC.md)；皮肤自定义教程在 [src/renderer/skins/README.md](src/renderer/skins/README.md)。

---

## 1. 这是什么

透明无边框的桌面宠物（Electron），主进程定期轮询推理服务（**vLLM** 或 **SGLang**）的
`/health` 与 `/metrics`，把负载映射成 7 种视觉状态（空闲/睡觉/连接中/轻中重三档推理/离线）
+ 一次性"庆祝"动画。形象是内联 SVG + CSS keyframes，无前端框架。

## 2. 架构与数据流

```
vllm serve ─┐
            ├─HTTP─> PollerService (主进程) ──IPC "status:update"──> PetStateMachine ──> PetView
sglang serv ┘         src/main/poller-service.js                       state-machine.js    pet.js
                             │                                               │
                             └── GET /health (失败时 /v1/models 兜底)        └── deriveState 纯函数
                                 GET /metrics ──> parsePrometheusMetrics        (shared/status-core.js)
                                 GET /v1/loads ──> parseLoadsResponse（兜底）
```

**采集链路（poller-service.js `_poll`，配置 `backend` = auto/vllm/sglang）**：

1. 判活：`healthPath` 保持默认 `/health` 时依次试**非生成式**端点 `/ready`（SGLang）→ `/v1/models`
   （OpenAI 标准），都没有才用 `<healthPath>`（SGLang 的 `/health` 默认会真生成 1 个 token，
   见 §4.11）；自定义过 healthPath 就尊重用户配置
2. `GET <apiBase><metricsPath>` → `parsePrometheusMetrics`：`vllm:*` 与 `sglang:*` 两族指标名
   一起认（按前缀区分，多 rank 求和，见 §3.6）
3. SGLang 再取 `GET /v1/loads?include=core`（≥ 0.5.8）→ `parseLoadsResponse`，用 `mergeLoads()`
   合成：**计数（running/waiting/cacheUsage）用这份实时值**，counter 与 genThroughput 仍用 /metrics
   —— 因为 Prometheus gauge 空闲后会冻结（§4.10）；探测失败/404 后 60s 内不再重试
   （`_loadsUnsupported` 退避），`backend='vllm'` 或 /metrics 已认出 vLLM 时直接跳过
4. `sampleActivity()` 判"是否在推进"（prefill 盲区，§4.9）、`sampleGenerationRate()` 算 tok/s，
   再 `deriveState({ active })` 推导状态；快照附 `backend`（认出的引擎）、
   `loadSource`（loads/metrics/none，表示**计数**来自哪）、`prefillActive`、`hint`

**三层状态模型，改代码时务必分清：**

| 层 | 类型 | 例子 | 位置 |
| --- | --- | --- | --- |
| 快照状态 | `offline/connecting/idle/busy` + `intensity 0-3` | `{state:'busy', intensity:2}` | `status-core.js#deriveState` |
| 视觉状态 | 7 个字符串 | `busy-2`、`sleeping`、`offline` | `state-machine.js`（睡觉计时、庆祝触发、`stateMap` 映射） |
| 呈现 | CSS class | `.st-busy-2`、`.is-celebrating` | `robot.css` + `pet.js#setState` |

**三个页面：**

| 页面 | 入口 | 用途 |
| --- | --- | --- |
| `pet.html` | `src/renderer/pet-main.js` | 桌宠窗口（Electron 加载 `dist/pet.html`） |
| `settings.html` | `src/renderer/settings-main.js` | 独立设置窗口（首次运行/右键宠物/托盘打开） |
| `index.html` | `src/renderer/preview-main.js` | 浏览器预览页（`npm run dev`，Mock 数据源 + 可直连） |

**目录地图：**

```
src/main/main.js            主进程装配：窗口/托盘/IPC/冒烟截图/windowSize()
src/main/poller-service.js  轮询 + 状态推导（_everConnected 决定是否报 offline）
src/main/updater.js         自我更新主流程：检查 GitHub Release → 对话框 → 下载替换重启（mac 一键，win/linux 跳发布页）
src/main/download.js        下载（带进度）与 zip 解压（ditto/unzip），无 Electron 依赖可单测
src/main/config-store.js    config.json 读写与默认值（深合并）
src/main/preload.cjs        contextBridge 暴露 window.vllmPet（CommonJS）
src/shared/status-core.js   ★ 纯函数，零依赖零副作用，主进程/渲染层/测试三方共用
src/shared/update-core.js   ★ 更新相关纯函数：版本比较 / pickAsset 选包 / 守护脚本模板
src/renderer/robot/pet.js   PetView：挂载 SVG、切视觉状态、缩放、庆祝闪光
src/renderer/robot/robot.css 全部动画与状态样式（.st-* / .fx-* / .r-*）
src/renderer/status/state-machine.js  快照 → 视觉状态（含 stateMap、睡觉计时）
src/renderer/status/providers.js      IPC / Mock / 浏览器直连三种状态来源 + 默认配置
src/renderer/ui/settings-panel.js     浏览器模式下的内嵌设置气泡
src/renderer/skins/         皮肤加载器 + 内置皮肤（default-robot + 4 款换色）
scripts/mock-vllm.mjs       假推理服务（--backend vllm|sglang、--no-metrics、--prefill、--stale-gauge N、--health-generates、--no-ready、--log-requests、--port/--running/--waiting/--cache/--cycle）
scripts/probe-load.mjs      排障用：打印某地址的采集结果（状态/引擎/数据来源/逐项 HTTP 码）
scripts/smoke.mjs           集成冒烟（隐藏窗口 + 截图，见 §5）
scripts/dev-desktop.mjs     vite dev server + Electron 热更新联调
tests/*.test.mjs            node --test，89 个用例
```

## 3. 关键设计决策（勿轻易推翻）

1. **轮询在主进程**：浏览器 fetch 跨源受 vLLM CORS 限制；主进程 Node fetch 天然免疫。
   预览页"直连真实服务"失败是预期行为，不是 bug。
2. **`status-core.js` 保持纯函数**：不得 import 任何模块、不得碰 window/process，
   否则主进程与单测都会挂。
3. **动画 = 状态 class，不是 JS 驱动**：`pet.js#setState` 只切 `.st-*` class，
   一切运动都在 CSS keyframes 里。新加动作优先写 CSS，不要引入 JS 动画循环。
4. **离线判定需要"曾经连上过"**：`_everConnected=false` 时的失败是 `connecting`，
   成功过一次之后再失败才是 `offline`。
5. **皮肤只是数据**：`skin.json`（配色/动画时长/palette）+ 可选整只 `robot.svg` 替换；
   加载逻辑在 `skin-loader.js`，用户皮肤目录 `<userData>/skins/<name>/`。
6. **指标解析与引擎无关**：`status-core.js` 的 `METRIC_SPECS` 把 `vllm:*` / `sglang:*` 两族
   指标名映射到同一套字段（running/waiting/cacheUsage/…），新增引擎只需往表里加行。
   聚合规则是这个文件里最容易被改错的部分：
   - **并发类 gauge 跨 label 求和**（多 DP/TP rank、多 model 是不同子集，相加才是总量）
   - **例外：SGLang 开 priority 调度时 label 分两层**——`priority=""` 是总量行，
     `priority="0"/"1"` 是分档行；两者相加会双倍计数，所以只取总量行
     （`_log_gauge_queue_count` 同时写两层，见 SGLang 源码）
   - **比率类（KV cache）跨 label 取最大**：比率相加无意义，任一 rank 逼近上限即算重载
   - **counter 跨 label 求和**：`*_tokens_total` 带 `is_streaming` 等 label，分片相加才是总量
   - **选对 counter**：SGLang 的 `generation_tokens_total` 只在**请求结束**时累加
     （`observe_one_finished_request`），长请求进行中差值为 0——“显示不出 tok/s”往往就是它；
     SGLang 要用每次迭代都累加的 `realtime_tokens_total{mode="decode"}`，
     并用 `gen_throughput` 兼顾刚起步/Prefill 阶段（策略集中在 `sampleGenerationRate()`）
   - **SGLang 并发 gauge 有 prefill 盲区**（→ 见 §4.9）：`running`/`waiting` 都为 0 不等于空闲，
     `deriveState({ active })` 的 `active` 由 `sampleActivity()` 给（prefill 计数 / decode 计数 / KV 占用
     是否在增长，计数器优先、gauge 兜底）
   - 指标名是**精确匹配**（先切出名字再查表），所以 `*_total` / `*_by_reason` /
     `*_offline_batch` / `full_token_usage` 这类同前缀指标不会被误吞
7. **读不到负载指标时不能断言"空闲"**：健康但无负载数据（SGLang 未开 `--enable-metrics`
   且 `/v1/loads` 也不行）时状态仍是 idle，因此快照带 `hint`，UI 会显示
   `空闲中（未读到负载指标）`；新增后端时保持这个降级语义，不要静默假装一切正常。
8. **计数只取"现算"的来源，不取推送快照**：SGLang 的 Prometheus gauge 空闲后会冻结（§4.10），
   所以 running/waiting/KV 以 `/v1/loads`（请求时现算）为准，`/metrics` 只提供 counter 与吞吐。
   新增后端时先分清：这个数字是"请求时现算"还是"最后一次推送"？后者不能用来判断"现在忙不忙"。
9. **悬停命中是「矩形 + 指针事件锁存」，不要交回 CSS 伪类**：
   「鼠标悬停在宠物上变透明」的命中区 =
   `clamp( union( pad(本体 ∪ 地面阴影, 12×缩放), padY(当前可见状态文字, 12×缩放) ), 宠物容器 )`
   （`src/shared/hover-region.js#computeHoverRect`；`pet.js#getHoverRect()`）。
   **状态文字只在纵向参与外扩（`padRectY`），横向绝不外扩** —— 两个方向解决的是不同问题：
   - 纵向外扩是「可停区」：文字底 + 12×缩放 才到窗口底（1 档 272+12 → 裁到 280 = v0.3.0 的余量）。
     v0.3.1 一度把这段余量去掉（文字用原盒），结果手停在文字下方 2–8px 就被判成矩形外，
     「穿过去淡一下、停下就恢复」（用户实测回归）。
   - 横向绝不外扩：长文字本身已接近窗口宽，横向再加 12px 会把矩形撑成整窗，
     「从文字上移开」就再也恢复不了（v0.3.0 的缺陷）。气泡宽度上限同时收紧到容器宽的 72%，
     保证两侧始终有可退出的空白（1 档 ≈33px、2 档 ≈72px）。
   判定只在指针事件里发生（事件挂**容器**：桌面 `#app`、预览 `#pet-holder`），结果写成舞台的
   `.is-hovering` class；CSS 只负责
   `.pet-stage.hover-fade-enabled.is-hovering .pet-scale/.pet-shadow/.pet-status-wrap { opacity: var(--hover-opacity) }`
   与 160ms / 180ms 过渡。命中矩形是**懒计算 + 脏标记**（`setStatusLine/setScale/setStatusFontSize/
   setState/celebrate/applySkin`，以及容器 resize（`_watchContainerResize`，ResizeObserver）与
   容器滚动（`_watchContainerScroll`，window 上的 scroll 捕获）置脏），
   不在每帧、不在定时器里重算。resize 只重算矩形（顺带按新容器重排气泡宽度）；resize 与滚动都
   **不翻转** `.is-hovering`（指针没动，状态就不翻）。
   - 状态文字有独立包装层 `.pet-status-wrap`：外层负责悬停淡化、气泡自身保留 0/1 显隐与 0.25s，
     两个 opacity 相乘 —— **不要**把淡化直接写到 `.pet-status` 上（隐藏文字时会被拉出来）。
   - `pointermove` 是主路径；`pointerover` **只吃一次**（加载/窗口重新获得焦点时指针可能已经停在
     本体上，此时不会再有 pointermove），吃完即解除武装 —— 因为 Chromium 在「指针没动、元素随动画
     变化」时也会派发 pointerover，每次都采信就等于把抖动引回来（实测 idle 3–5 次/3.3s、celebrate 13 次）。
   - **不要**改回 `:has(.r-hover:hover)`（或容器 `:hover`）：伪类会跟随命中测试**逐帧重算**，
     宠物自身的 bob/sway/celebrate 一直在动，静止指针会被扫过 → opacity 在设定值与 1 之间呼吸式明暗
     （实测 3 次/3.3s，最坏连续失效 2.4–3.9s，180ms 离开宽限盖不住）。
   - **不要**改成 `.pet-stage:hover` / `.pet-scale:hover` / `.r-svg:hover` 这类「整舞台/整窗」命中：
     那会把矩形外的空白也包进来（用户最初抱怨的就是这个）。
   - 外扩量不是保险箱而是**位移预算**：它覆盖 bob ±7、sway ±4.3、shake ±1.6；celebrate 的 −26px 超出预算，
     静止在矩形边界上遇到庆祝仍可能有一次过渡（可接受，属宠物真的移开）。
   - 复位路径必须齐全：`pointerleave`、`pointercancel`（触摸被打断）、`window.blur`、`visibilitychange`、
     `power:pause`、关闭开关都要清 `.is-hovering`；换肤只需重算矩形（状态保留）。
   - 命中相关的回归用 `node scripts/probe-hover.mjs`（矩形语义、合成指针事件端到端）与「指针不动采样
     opacity」（状态机：指针只移动一次后不再发事件，150ms 采样 `getComputedStyle('.pet-scale').opacity`
     3.3s，`|Δ|>0.05` 的次数必须为 0）。
   - **0.6 档为什么要用容器而不是舞台作事件边界**（实测）：舞台被 flex 压到 86px 宽，而气泡上限
     `round(容器宽 × 0.72)` = 104px → 文字左右各溢出舞台约 9px；矩形先并文字原盒再裁剪到容器，
     所以文字边缘仍可触发。探针里本体点用 `getScreenCTM()` 换算正是因为这段压缩+留边。

10. **穿透下的悬停：平台分级 + 存活证明，不要「所有平台统一轮询」**：
   窗口一旦 `setIgnoreMouseEvents(true)`，很多平台就收不到鼠标事件；更麻烦的是「主进程读到的光标位置」
   本身可能冻结（读数不变既可能是光标停着，也可能是 API 卡住）。
   **实测结论（本仓 Linux/X11 + Electron 43.1.1，2026-11 recheck）**：
   - S1：`setIgnoreMouseEvents(true)` 在 X11 上**没有改变 X Input Shape**（仍是整窗矩形），点击被吞 ——
     既不进宠物也不落到底层窗口；`forward:true` 同样无效。对应上游 `electron#52456`
     （43.2.0 报告、43.7.1 未修、42.7.0 正常）。**穿透本身在 Linux 就是坏的，与本功能无关。**
   - S2：普通模式下 `screen.getCursorScreenPoint()` 精确（6/6 与 `XQueryPointer` 一致）；
     **穿透模式（ignore=true）下读数冻结**（连续 6 次采样停在旧值，指针已移动；双窗口场景 3/3 陈旧）。
   - 因此 Linux 不进入这条路径（`HOVER_SUPPORTED_PLATFORMS` 只有 `win32`/`darwin`），行为与 v0.2.0 一致。
   **实现要点（`src/main/hover-monitor.js`）**：
   - 任何来源必须先「出示存活证据」才能改状态：事件源 = 收到**带坐标**的转发指针事件（`pointerleave`
     不算）；轮询源 = 同一会话内出现 **≥2 个不同读数**。冻结的源永远拿不到权威。
   - 种子（启动时若光标已在窗口内先推一次）只在 **1.5s** 内有效；到期没有任何来源获证就撤回并记一次日志
     —— fail-closed：最坏是「不淡化」，不是「卡在淡化」。
   - 事件源优先：取得权威后**停轮询**（稳态零轮询）；采样抛错/非有限坐标 → 清状态 + 停轮询 + 只记一次 +
     通知渲染层回指针模式，**永不抛到未捕获异常**。
   - `sync()`/`hover:cursor:get`（页面重载握手）必须**采样「此刻」**，不能交缓存残值；既无权威又无有效种子
     时直接给 `null`（冻结源的读数不得被握手点亮）。
   - 穿透会话内渲染层**不**用 `blur`/`visibilitychange` 复位（穿透窗口几乎不获得焦点，靠它会误清且不自愈），
     `pointerleave`/`pointercancel` 仍复位；「离开窗口/隐藏/最小化/锁屏/休眠/退出」由主进程推送 `null` 或停轮询。
   **平台宣称的门槛（2A，实机三项，缺一不可；未过即把该平台从白名单移除）**：
   1. `clickThrough=true` 时点击宠物区域 → 事件落到**下层窗口**（穿透有效）。
   2. `clickThrough=true` 时鼠标移过宠物 → 渲染层收到 `pointermove`/`pointerleave`（转发有效）。
   3. `clickThrough=true` 时移动光标 3 次 → `getCursorScreenPoint()` 给出 **≥3 个不同读数**（读数不冻结）。
   Linux 的两项复现方法（X11）：`xshape` 查 `ShapeInput` 矩形数（穿透后仍是 1 个整窗矩形）；
   `XTest` 真点击 + 双窗口日志对照（宠物窗口与下层窗口都收不到）；穿透模式下每 200ms 采样一次
   `screen.getCursorScreenPoint()` 并同步移动指针，比对是否停在旧值。

## 4. ⚠️ 排坑指南（都踩过，别再踩）

1. **CSS transform 会覆盖 SVG 元素的 `transform` 属性。**
   任何要带 CSS transform 动画（scale/translate keyframes）的 SVG 元素，
   必须**外层 `<g transform="translate(x,y)">` 负责定位、class 挂内层**。
   （离线感叹号曾因此飞到画布原点附近。）
2. **特效元素一律画进 SVG 的 `.r-fx` 分组**（viewBox `0 0 240 280`），
   用 SVG 坐标定位。按窗口像素绝对定位的 DOM 元素在体型缩放后必然漂移（汗滴曾偏到侧边）。
3. **舞台几何**：`.pet-stage` 固定 240×280，`pet.js#setScale` 以 `transform-origin: 50% 0`
   整体缩放；机器人身体最低点 y≈224，地面阴影 y≈223-241，状态气泡底部锚定 y=272。
   窗口尺寸 = `240×280 × scale`（`main.js#windowSize`，`STATUS_H=0`）。
   **改布局要同步四处**：`robot.css .pet-status`、`pet.js setScale`、`main.js windowSize`、
   `index.html #pet-holder`（预览页留白）。
4. **配置默认值有两处**：`src/main/config-store.js` 和 `src/renderer/status/providers.js`
   （浏览器 Mock 模式用）。新增配置字段时两处都要加，深合并靠 config-store。
5. **杀后台 mock/脚本进程用 `pkill -f "mock-vllm.mjs --port N"`**。
   `kill $!` 杀的是包了一层 `cd && node ...` 的 shell，node 本体会残留并继续占用端口。
6. **Electron 二进制下载**：国内网络 `npm install` 的 postinstall 会失败，用
   `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js` 修复。
7. **打包命令必须带镜像与关签名**（无开发者证书）：
   ```bash
   ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
   CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg
   ```
   electron-builder 偶发网络超时，重试即可；产物在 `out/`。
8. **别用 vLLM 的指标名去猜 SGLang**：SGLang 的指标名完全不同（`sglang:num_running_reqs` /
   `sglang:num_queue_reqs` / `sglang:token_usage`），而且**默认不暴露 `/metrics`**
   （要启动加 `--enable-metrics`，`enable_metrics` 默认为 `False`）。只认 `vllm:*` 会导致
   "明明在推理却显示空闲中"——这正是 `backend` 兜底与 `hint` 存在的原因。
9. **SGLang 并发 gauge 有 prefill 盲区**（典型症状：长 prompt 的 prefill 阶段显示"空闲"）：
   `num_running_reqs = len(scheduler.running_batch.reqs)`，而 `get_next_batch_to_run()` 里
   `chunked_req_to_exclude.add(self.chunked_req)` 的注释写着 "Move the chunked request out of
   the batch so that we can merge only finished requests to running_batch"——正在 prefill 的请求
   被故意排除在 `running_batch` 之外，也不在 `waiting_queue`（它在 `self.chunked_req` 里）。
   `/v1/loads` 的 `num_running_reqs` 同样是 `len(running_batch.reqs)`，同样中招。
   所以 **`running + waiting == 0` 不能直接当空闲**，必须配合 `sampleActivity()` 的 `active`
   （prefill 每次迭代都累加的 counter、decode 迭代计数、以及 KV 占用增长）。
   注意 `decode_log_interval` 默认 40：并发 gauge 每 40 个 decode 迭代才刷新一次，
   短短几十 token 的生成也可能整段看不到，这就是为什么 decode 计数也纳入活动信号。

10. **SGLang 的 Prometheus gauge 空闲后会冻结**（症状：服务已经空了，桌宠还停在"推理中"一段）：
   `/metrics` 是推送式，`num_running_reqs = len(batch.reqs)` 在**过滤掉已完成请求之前**就打了，
   而空闲路径 `_maybe_log_idle_metrics()` 把所有 emit 节流到 30s 一次——于是最后一批的数值会原样
   卡住（上游 PR #26495 实测 `24` 卡了整整 30s；另有更早的 `--metrics-flush-interval` PR #4285）。
   对策就是我们不用它判忙闲：计数取 `/v1/loads`（请求时现算），见 `mergeLoads()` 与 §3.8。
   注意 SGLang < 0.5.8 没有 `/v1/loads`，只能吃这个滞后（probe 会提示）。

11. **别让监测端把服务喂成"在推理"**：SGLang 的 `/health` 默认**会真生成 1 个 token**
   （`SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION` 默认 `True`，`http_server.py` 里只有关掉它才直接
   返回 200；而且 `is_fully_idle()` 时才会真跑，正好是我们的空闲场景）。它有两重伤害：
   ① 每次探活都真跑一次生成（每 2s 一次 = 白烧显卡）；
   ② **那个 1-token 请求会短暂出现在 `running_batch`/`waiting_queue` 里**，而我们紧接着请求的
   `/v1/loads` 会把它数成"正在运行"——于是空闲时永远显示"推理中 ×1 · 0.5 tok/s"
   （1 token / 2s 正好 0.5 tok/s）。注意 ② 是关键：光看 counter 增长会被速率门槛挡住，
   但并发数被顶上去是挡不住的。修法：**判活链路必须是"非生成式优先"**——
   默认 `healthPath` 时依次试 `/ready`（SGLang 就绪检查）→ `/v1/models`（OpenAI 标准）→
   `healthPath`(/health 兜底)；404/405 记住不再探，401/403 继续试下一个，
   自定义过 `healthPath` 则完全尊重用户配置。复现与验证：
   `node scripts/mock-vllm.mjs --backend sglang --health-generates [--no-ready] --running 0 --waiting 0 --log-requests`
   （mock 会如实让幽灵请求出现在 `/v1/loads` 里，并打印收到的端点，可直接确认没打 `/health`）。

## 5. 验证工作流（提交前必做）

11. **别让监测端把服务喂成"在推理"**：SGLang 的 `/health` 默认**会真生成 1 个 token**
   （`SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION` 默认 `True`，`http_server.py` 里只有关掉它才直接
   返回 200；而且 `is_fully_idle()` 时才会真跑，正好是我们的空闲场景）。轮询每 2s 探一次
   ＝ 0.5 tok/s 的连续 decode 计数增长 → 活动信号判"在忙" → 症状是"空闲时还显示推理中 0.5 tok/s"，
   同时白烧显卡。两道防线：① `healthPath` 为默认值时优先用非生成式 `/ready`
   （404/405 才回落 healthPath，`_readyUnsupported` 只探一次）；② 活动判定要过
   `ACTIVITY_MIN_TOKENS_PER_SEC`（5 token/s）的速率门槛，滤掉 1 token 级抖动。
   复现：`node scripts/mock-vllm.mjs --backend sglang --health-generates [--no-ready]`。
9. **SGLang 并发 gauge 有 prefill 盲区**（典型症状：长 prompt 的 prefill 阶段显示"空闲"）：
   `num_running_reqs = len(scheduler.running_batch.reqs)`，而 `get_next_batch_to_run()` 里
   `chunked_req_to_exclude.add(self.chunked_req)` 的注释写着 "Move the chunked request out of
   the batch so that we can merge only finished requests to running_batch"——正在 prefill 的请求
   被故意排除在 `running_batch` 之外，也不在 `waiting_queue`（它在 `self.chunked_req` 里）。
   `/v1/loads` 的 `num_running_reqs` 同样是 `len(running_batch.reqs)`，同样中招。
   所以 **`running + waiting == 0` 不能直接当空闲**，必须配合 `sampleActivity()` 的 `active`
   （prefill 每次迭代都累加的 counter、decode 迭代计数、以及 KV 占用增长）。
   注意 `decode_log_interval` 默认 40：并发 gauge 每 40 个 decode 迭代才刷新一次，
   短短几十 token 的生成也可能整段看不到，这就是为什么 decode 计数也纳入活动信号。

```bash
npm test          # ① 单元测试（status-core 解析/推导 + state-machine 映射/睡觉/庆祝）
npm run build     # ② Vite 构建（渲染层三个页面 → dist/）
npm run smoke     # ③ 集成冒烟：隐藏窗口启动 Electron，截图 smoke-pet.png 后退出
```

**悬停命中区回归（改了 `robot.css` 的悬停规则 / `pet.js` 的命中判定 / 皮肤 SVG 后跑）**：

```bash
npm run build && node scripts/probe-hover.mjs
# 依次以 0.6 / 1 / 2 缩放启动隐藏窗口，把 scripts/hover-probe.js 注入页面逐点校对它的 POINTS 坐标表
# 输出：HOVER-PROBE scale=<x> pass=<n> fail=0；任一档失败则打印具体坐标与期望值并以非零退出
```

- 探针是**端到端**的：每个点向容器派发一次合成 `pointermove`，读舞台是否带 `.is-hovering`，
  不自己重算几何。本体上的点用 SVG viewBox 坐标经 `getScreenCTM()` 换算（0.6 档舞台被压缩+留边时
  仍正确），空白/容器外用容器坐标，阴影/文字点取各自 DOM 框中心。
- 通过时是 **`pass=15`**（三档都一样）；`fail>0` 就是真问题，**没有「跳过」这条出口**：
  - 点表 12 条：矩形内 9 条必中 + 矩形外 3 条必不中；
  - `(20,140)`/`(225,140)` 这两个「左右空白」是**强制校验**：判定基准按现行口径复算
    `union(pad(本体∪阴影), 文字原盒)`，反例落到矩形里就直接记 fail（上一轮正是把它跳过，才漏掉了
    「长文字把矩形撑成整窗」）；
  - 再加 1 条硬断言：状态文字可见时，命中矩形与容器**左右间距均 ≥6px**。
    这个 6px 是**红灯阈值（回归哨兵），不是精度指标**：它的用途是「一旦谁把气泡上限或文字外扩改回去、
    矩形又贴近窗口边缘，就立刻红」，不代表产品要求矩形必须留 6px。
- 冻结动画的前提：探针先往页面注入一条样式
  `.pet-scale,.r-head,.r-arm,.r-antenna-glow,.r-shadow{animation:none!important}` ——
  是 `animation: none`（**移除**动画，元素回到基础状态），不是 `animation-play-state: paused`
  （那是停在当前相位）。因为矩形取的是「当前帧包围盒」，不冻结会让采样点随 bob/sway 的相位飘。
- 可复算的**最小退出距离**：命中矩形在本体外扩 `12×缩放` 之外，而本体自身摆动包络约 `4.4×缩放`，
  所以指针从本体边缘起至少要移动 `12 − 4.4 ≈ 7.6×缩放` px 才算出矩形（1 档 ≈7.6px、0.6 档 ≈4.6px、
  2 档 ≈15.2px）。文字侧：横向边界 = 文字盒（文字比本体外扩盒宽时）或本体外扩盒；
  纵向边界 = 文字盒 ± 12×缩放（纵向余量）。
- 抖动不回归是**另一套口径**，探针替代不了（动画已被 `animation: none` 移除，探针看不到抖动）：
  指针只移动一次后不再发事件，每 150ms 采样 `getComputedStyle('.pet-scale').opacity` 共 3.3s，
  `|Δ|>0.05` 的次数必须为 0。

**冒烟环境变量**（主进程 `VLLM_PET_SMOKE=1` 时生效，配置用临时目录，不碰用户数据）：

| 变量 | 作用 |
| --- | --- |
| `VLLM_PET_SMOKE_APIBASE` | 预置服务地址（通常指向 mock-vllm） |
| `VLLM_PET_SMOKE_SCALE` | 预置体型缩放，如 `0.7` / `1.5` |
| `VLLM_PET_SMOKE_PAGE` | 加载页面（默认 `pet.html`，可设 `index.html` 截预览页） |
| `VLLM_PET_SMOKE_SIZE` | 窗口尺寸，如 `1000x780` |
| `VLLM_PET_SMOKE_DELAY` | did-finish-load 后延迟多少毫秒截图（默认 2500） |
| `VLLM_PET_SMOKE_HOVER_PROBE` | `1` = 不截图，改为执行 `scripts/hover-probe.js` 并把结果打到 stdout（供 `scripts/probe-hover.mjs` 汇总；正常运行路径不受影响） |

冒烟模式下主进程会打印每次状态推送（`[smoke] state = ... hint = ...`），方便确认状态流转。

**采集链路不用开 Electron 就能验证**（改 `status-core.js` / `poller-service.js` 后最快的手段）：

```bash
# ① 单元 + 集成用例（假服务 + 真 PollerService，覆盖 SGLang 指标/priority/loads 兜底/退避）
npm test

# ② 起 mock 后用 probe 脚本看真实采集结果（状态、引擎、数据来源、逐项探测 HTTP 码）
node scripts/mock-vllm.mjs --port 18101 --backend sglang --running 24 --waiting 9 --cache 0.92 &
node scripts/mock-vllm.mjs --port 18102 --backend sglang --no-metrics --running 24 --waiting 9 &
node scripts/mock-vllm.mjs --port 18103 --running 2 --waiting 0 --cache 0.4 &
sleep 1
node scripts/probe-load.mjs http://127.0.0.1:18101 auto     # → busy/loadSource=metrics
node scripts/probe-load.mjs http://127.0.0.1:18102 auto     # → busy/loadSource=loads（/metrics 404）
node scripts/probe-load.mjs http://127.0.0.1:18102 vllm     # → idle/hint=未读到负载指标（不试兜底）
node scripts/probe-load.mjs http://127.0.0.1:18103 auto     # → busy/backend=vllm（回归）
pkill -f "mock-vllm.mjs --port 181"
```

**SGLang prefill 盲区专项验证**（改 `sampleActivity` / `deriveState` / 状态文案后必跑）：

```bash
# --prefill：并发 gauge 恒为 0（模拟 chunked prefill），prefill 计数与 KV 占用在涨
node scripts/mock-vllm.mjs --port 18105 --backend sglang --prefill &
node scripts/mock-vllm.mjs --port 18106 --backend sglang --no-metrics --prefill &
node scripts/mock-vllm.mjs --port 18107 --backend sglang --running 0 --waiting 0 &
sleep 1
node scripts/probe-load.mjs http://127.0.0.1:18105 auto   # 第 2 次采样 → busy/prefillActive=true
node scripts/probe-load.mjs http://127.0.0.1:18106 auto   # 同上，只是走 /v1/loads 兜底
node scripts/probe-load.mjs http://127.0.0.1:18107 auto   # 真空闲 → 必须保持 idle（防误报）
pkill -f "mock-vllm.mjs --port 181"
```

**gauge 冻结专项验证**（改 `mergeLoads` / 计数来源后必跑）：

```bash
# --stale-gauge：/metrics 永远报 running=8（模拟冻结），/v1/loads 报实时值
node scripts/mock-vllm.mjs --port 18108 --backend sglang --stale-gauge 8 --running 0 --waiting 0 &
node scripts/mock-vllm.mjs --port 18109 --backend sglang --stale-gauge 8 --running 6 --waiting 1 &
sleep 1
node scripts/probe-load.mjs http://127.0.0.1:18108 auto   # 应 idle（不信冻结的 8）
node scripts/probe-load.mjs http://127.0.0.1:18109 auto   # 应 busy 且 running=6（实时值）
pkill -f "mock-vllm.mjs --port 181"
```

**视觉验证的标准动作**（改任何 `robot.svg` / `robot.css` / 布局后都要做）：

```bash
# 中载/重载：起 mock → 截图 → pkill
node scripts/mock-vllm.mjs --port 18099 --running 24 --waiting 9 --cache 0.92 &
sleep 1
VLLM_PET_SMOKE_APIBASE=http://127.0.0.1:18099 VLLM_PET_SMOKE_SCALE=1.5 node scripts/smoke.mjs
pkill -f "mock-vllm.mjs --port 18099"

# SGLang 两种采集路径同样可冒烟（--backend sglang / 再加 --no-metrics 走 /v1/loads 兜底）
node scripts/mock-vllm.mjs --port 18098 --backend sglang --no-metrics --running 24 --waiting 9 &
sleep 1
VLLM_PET_SMOKE_APIBASE=http://127.0.0.1:18098 node scripts/smoke.mjs   # 应打印 state = busy
pkill -f "mock-vllm.mjs --port 18098"

# 离线：先让它连上一次，再 pkill mock，加大截图延迟等状态转 offline
node scripts/mock-vllm.mjs --port 18099 --running 0 --waiting 0 &
sleep 1
(VLLM_PET_SMOKE_APIBASE=http://127.0.0.1:18099 VLLM_PET_SMOKE_DELAY=6000 node scripts/smoke.mjs &)
sleep 2 && pkill -f "mock-vllm.mjs --port 18099" && sleep 9
```

截图后用看图工具确认：表情/特效位置（尤其 0.7× 与 1.5× 两端缩放）、气泡不遮本体、窗口无裁切。

**打安装包验证**：按 §4.7 命令打 DMG；CI（`.github/workflows/release.yml`）在推 tag 时
自动产出 Win/macOS/Linux × x64/arm64 全平台包。

## 6. 常见扩展任务清单

**新增一个配置项**（以 `fooBar` 为例，一处都不能漏）：
1. `src/main/config-store.js` 默认值
2. `src/renderer/status/providers.js` Mock 默认值
3. `src/renderer/ui/settings-panel.js` 设置窗口/预览页共用表单 + 保存
4. 消费方（`pet-main.js#applyConfig` / `poller-service.js` / `main.js#applyWindowConfig`）
5. README 配置表

**新增一个视觉状态**（如 `error`）：
1. `pet.js` `VISUAL_STATES` 数组加名字
2. `robot.css` 写 `.st-error` 样式（需要新图形时同步改 `robot.svg` 与皮肤钩子表）
3. `state-machine.js` 决定什么快照映射到它（注意 `stateMap` 校验白名单）
4. `skins/README.md` 更新状态列表；`tests/state-machine.test.mjs` 加用例

**调整负载分档逻辑**：只改 `status-core.js#deriveState`（+ `DEFAULT_THRESHOLDS`），
单测在 `tests/status-core.test.mjs`。别把推导逻辑塞进 poller 或渲染层。

**新增/修改后端采集**（如再支持一个新引擎）：
1. `status-core.js#METRIC_SPECS` 加指标名 → 字段映射（聚合规则见 §3.6）
2. 需要额外接口兜底时改 `poller-service.js#_poll`，并在 `providers.js#LiveFetchProvider` 同步
3. `status-core.js#BACKENDS` + 两处默认值加 `backend` 选项，设置面板 `BACKEND_OPTIONS` 加一项
4. `tests/status-core.test.mjs` / `tests/poller-service.test.mjs` 加用例，`mock-vllm.mjs` 加 mock 模式

**做新皮肤**：读 [src/renderer/skins/README.md](src/renderer/skins/README.md)；
SVG class 钩子表以它为准。改 `default-robot/robot.svg` 的结构（新增/改名 class）时，
必须同步更新该 README 的钩子表。

## 7. 当前边界与后续方向（已知未做）

- macOS 包为 adhoc 签名：浏览器下载带隔离属性后首次打开会报"已损坏"，
  需 `xattr -dr com.apple.quarantine <app路径>` 移除隔离（README 已写明）。
  根治需 Apple 开发者账号签名 + 公证（CI 配 CSC/APPLE 相关 secrets）。
- Windows/Linux 实机未人工验证过（CI 构建通过，未实际上机运行）。
- **穿透下的悬停（透传淡化）**：Windows/macOS 已实现，但**尚未实机验收** —— 需按 §3 决策 10 的
  2A 三项在真机上各跑一次；任一项不过就把该平台从 `HOVER_SUPPORTED_PLATFORMS` 移除（宁可少一个反馈，
  也不宣称一个不生效的功能）。Linux 已实机确认不可用（X11 穿透被上游 #52456 破坏 + 穿透下光标读数冻结；
  Wayland 无全局光标 API），因此 Linux 恒关闭，悬停只在未开穿透时生效。
- 窗口位置记忆（`window.x/y`）已实现；多显示器边缘吸附未做。
- SGLang 采集覆盖：已支持 `sglang:*` 指标（含 priority 分档、多 rank）与 ≥ 0.5.8 的
  `/v1/loads` 兜底；SGLang < 0.5.8 且未开 `--enable-metrics` 时只能判在线/离线（显示 hint）。
  未接 SGLang 的 `/server_info`（整份 server args，回报大）与 `/v1/loads` 的 memory/spec/queues 段。
- 候选增强：单击宠物显隐状态文本、皮肤热重载、更多内置皮肤、
  多服务轮询（多个实例聚合状态）、系统资源占用显示（GPU 显存）、
  SGLang router / DP 网关的聚合负载（当前只读单实例）。

## 8. 提交约定

- 分支 `main`，提交信息用中文 conventional commits（`feat:` / `fix:` / `docs:` / `chore:`）。
- 不提交 `dist/`、`out/`、`smoke-*.png`、`node_modules/`（已在 .gitignore）。
- 根目录不得出现打包产物；vite 输出只应落在 `dist/`。
