# vLLM Pet 开发指南

面向后续开发者（人类或 AI Agent）：读完这份文档即可安全地修改、扩展、验证本项目。
用户向的安装/使用说明在 [README.md](README.md)；初版多代理协作的设计契约（历史文档）在
[AGENT_SPEC.md](AGENT_SPEC.md)；皮肤自定义教程在 [src/renderer/skins/README.md](src/renderer/skins/README.md)。

---

## 1. 这是什么

透明无边框的桌面宠物（Electron），主进程定期轮询 `vllm serve` 推理服务的
`/health` 与 `/metrics`，把负载映射成 7 种视觉状态（空闲/睡觉/连接中/轻中重三档推理/离线）
+ 一次性"庆祝"动画。形象是内联 SVG + CSS keyframes，无前端框架。

## 2. 架构与数据流

```
vllm serve ──HTTP──> PollerService (主进程) ──IPC "status:update"──> PetStateMachine ──> PetView
                     src/main/poller-service.js                       state-machine.js    pet.js
                            │                                               │
                            └── GET /health (失败时 /v1/models 兜底)        └── deriveState 纯函数
                                GET /metrics ──> parsePrometheusMetrics        (shared/status-core.js)
```

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
scripts/mock-vllm.mjs       假 vLLM 服务（--port/--running/--waiting/--cache/--cycle）
scripts/smoke.mjs           集成冒烟（隐藏窗口 + 截图，见 §5）
scripts/dev-desktop.mjs     vite dev server + Electron 热更新联调
tests/*.test.mjs            node --test，30 个用例
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

## 5. 验证工作流（提交前必做）

```bash
npm test          # ① 单元测试（status-core 解析/推导 + state-machine 映射/睡觉/庆祝）
npm run build     # ② Vite 构建（渲染层三个页面 → dist/）
npm run smoke     # ③ 集成冒烟：隐藏窗口启动 Electron，截图 smoke-pet.png 后退出
```

**冒烟环境变量**（主进程 `VLLM_PET_SMOKE=1` 时生效，配置用临时目录，不碰用户数据）：

| 变量 | 作用 |
| --- | --- |
| `VLLM_PET_SMOKE_APIBASE` | 预置服务地址（通常指向 mock-vllm） |
| `VLLM_PET_SMOKE_SCALE` | 预置体型缩放，如 `0.7` / `1.5` |
| `VLLM_PET_SMOKE_PAGE` | 加载页面（默认 `pet.html`，可设 `index.html` 截预览页） |
| `VLLM_PET_SMOKE_SIZE` | 窗口尺寸，如 `1000x780` |
| `VLLM_PET_SMOKE_DELAY` | did-finish-load 后延迟多少毫秒截图（默认 2500） |

冒烟模式下主进程会打印每次状态推送（`[smoke] state = ...`），方便确认状态流转。

**视觉验证的标准动作**（改任何 `robot.svg` / `robot.css` / 布局后都要做）：

```bash
# 中载/重载：起 mock → 截图 → pkill
node scripts/mock-vllm.mjs --port 18099 --running 24 --waiting 9 --cache 0.92 &
sleep 1
VLLM_PET_SMOKE_APIBASE=http://127.0.0.1:18099 VLLM_PET_SMOKE_SCALE=1.5 node scripts/smoke.mjs
pkill -f "mock-vllm.mjs --port 18099"

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
3. `settings.html` / `src/renderer/settings-main.js` 设置窗口表单 + 保存
4. 消费方（`pet-main.js#applyConfig` / `poller-service.js` / `main.js#applyWindowConfig`）
5. README 配置表

**新增一个视觉状态**（如 `error`）：
1. `pet.js` `VISUAL_STATES` 数组加名字
2. `robot.css` 写 `.st-error` 样式（需要新图形时同步改 `robot.svg` 与皮肤钩子表）
3. `state-machine.js` 决定什么快照映射到它（注意 `stateMap` 校验白名单）
4. `skins/README.md` 更新状态列表；`tests/state-machine.test.mjs` 加用例

**调整负载分档逻辑**：只改 `status-core.js#deriveState`（+ `DEFAULT_THRESHOLDS`），
单测在 `tests/status-core.test.mjs`。别把推导逻辑塞进 poller 或渲染层。

**做新皮肤**：读 [src/renderer/skins/README.md](src/renderer/skins/README.md)；
SVG class 钩子表以它为准。改 `default-robot/robot.svg` 的结构（新增/改名 class）时，
必须同步更新该 README 的钩子表。

## 7. 当前边界与后续方向（已知未做）

- macOS 包为 adhoc 签名：浏览器下载带隔离属性后首次打开会报"已损坏"，
  需 `xattr -dr com.apple.quarantine <app路径>` 移除隔离（README 已写明）。
  根治需 Apple 开发者账号签名 + 公证（CI 配 CSC/APPLE 相关 secrets）。
- Windows/Linux 实机未人工验证过（CI 构建通过，未实际上机运行）。
- 窗口位置记忆（`window.x/y`）已实现；多显示器边缘吸附未做。
- 候选增强：单击宠物显隐状态文本、皮肤热重载、更多内置皮肤、
  多服务轮询（多个 vLLM 实例聚合状态）、系统资源占用显示（GPU 显存）。

## 8. 提交约定

- 分支 `main`，提交信息用中文 conventional commits（`feat:` / `fix:` / `docs:` / `chore:`）。
- 不提交 `dist/`、`out/`、`smoke-*.png`、`node_modules/`（已在 .gitignore）。
- 根目录不得出现打包产物；vite 输出只应落在 `dist/`。
