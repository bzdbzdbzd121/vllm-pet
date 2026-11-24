# 自定义皮肤教程

vLLM Pet 的形象与动画都可以自定义。皮肤是一个目录，放在应用的 **用户皮肤目录** 下：

```
<userData>/skins/<你的皮肤名>/
  skin.json        ← 必需
  robot.svg        ← 可选：完整替换机器人造型
```

`<userData>` 路径（Electron `app.getPath('userData')`）：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/vllm-pet/skins/` |
| Windows | `%APPDATA%/vllm-pet/skins/` |
| Linux | `~/.config/vllm-pet/skins/` |

保存后打开设置面板（右键宠物），在"皮肤"下拉框选择即可。

## 内置皮肤

以下皮肤随应用自带，无需安装，直接在设置里选择（均只改配色，造型与动画一致）：

| 皮肤名 | 显示名 | 配色 |
| --- | --- | --- |
| `default-robot` | 小V · 默认机器人 | 薄荷绿机身 + 珊瑚橙点缀 |
| `sakura-pink` | 小V · 樱花粉 | 粉色机身 + 青色天线灯 |
| `ocean-blue` | 小V · 海洋蓝 | 海蓝机身 + 黄色天线灯 |
| `sunny-orange` | 小V · 暖阳橙 | 橙机身 + 青色天线灯 |
| `graphite-dark` | 小V · 石墨黑 | 深灰机身 + 青眼 + 珊瑚橙灯 |

内置换色皮肤的注册方式见 `skin-loader.js` 的 `BUILTIN_SKINS`：新增一个只有
`palette` 的 `skin.json` 并登记即可，调色板会合并到默认皮肤之上。要做带自定义
`robot.svg` 的造型皮肤，则在皮肤目录里同时提供 `skin.json` 与 `robot.svg`。

## skin.json 字段

```json
{
  "name": "my-robot",               // 必须 = 目录名
  "displayName": "我的机器人",       // 下拉框显示名
  "version": 1,
  "palette": {                       // 可选，缺省沿用默认配色
    "body": "#ffd166",              // 机身主色
    "bodyShade": "#e0aaff",         // 机身深色描边/手臂
    "face": "#12232b",              // 脸屏底色
    "eye": "#7ef0ff",               // 眼睛/嘴巴发光色
    "accent": "#ff8a7a",            // 天线灯球/胸口灯/腮红
    "glow": "#9ff2ff"               // 光晕/速度线/Zzz
  },
  "animations": {
    "blinkMs": 4400,                 // 眨眼周期
    "bobMs": {                       // 各状态悬浮摆动周期（越小越急促）
      "idle": 3200, "sleeping": 5200, "connecting": 1800,
      "busy-1": 2200, "busy-2": 1400, "busy-3": 880, "offline": 5200
    }
  }
}
```

## robot.svg（可选）

提供自己的 SVG 即可完全替换造型（viewBox 建议 `0 0 240 280`，底部对齐悬浮阴影）。
只要保留下列 class 钩子，就能复用内置的全部状态动画：

| class | 作用 |
| --- | --- |
| `.r-hover` | 整体悬浮摆动分组（必需），**它的包围盒参与「鼠标悬停变透明」的命中矩形**（见下） |
| `.r-shadow` | 地面阴影 |
| `.r-head` | 头部（空闲/连接中会轻微摇摆） |
| `.r-antenna-glow` / `.r-antenna-bulb` | 天线光晕 / 灯球（状态指示灯） |
| `.r-face` | 脸屏（重载时闪烁） |
| `.r-eye-pill`（×2） | 默认眼睛（眨眼动画） |
| `.r-eye-arc`（×2） | 开心弯眼 ∩ ∩（庆祝时显示） |
| `.r-eye-closed`（×2） | 闭眼（睡觉时显示） |
| `.r-eye-squeeze`（×2） | 兴奋眯眼 > <（重载时显示） |
| `.r-mouth` | 微笑嘴（`重载` 时隐藏） |
| `.r-mouth-bar` | 横杠嘴 >\_<（`重载` 时显示） |
| `.r-cheek` | 腮红 |
| `.r-arm` `.r-arm-left` `.r-arm-right` | 手臂（中重载摆动） |
| `.r-body-shell` / `.r-chest` | 身体 / 胸口灯（忙碌时闪烁） |
| `.r-fx` | 粒子特效分组（见下表） |
| `.r-sparkles` | 庆祝闪光挂载点（空分组即可，必需） |

眼睛可见性规则：默认显示 `.r-eye-pill`；`睡觉` 显示 `.r-eye-closed`；`庆祝` 显示 `.r-eye-arc`；`重载` 显示 `.r-eye-squeeze` + `.r-mouth-bar`。
给元素上色时可以直接写死颜色，也可以用 `fill: var(--c-body)` 等 CSS 变量接入 palette。

### ⚠️ `.r-hover` 的包围盒会参与悬停命中矩形

命中区是**矩形**，不再是「绘制图形」：
本体与地面阴影的并集外扩 12×体型缩放，再并入当前可见状态文字的**原盒**（文字不加外扩），
最后裁剪到宠物容器。
其中「本体」优先取 `.r-hover` 的**包围盒**（`getBoundingClientRect`），取不到时退回 `.pet-scale`。
状态由指针事件锁存（不是 CSS `:hover`），所以宠物自己的呼吸/摇摆动画不会让状态自己翻转。

因此往这个分组里放东西时请遵守：

- **别把大手笔的不可见图形放进 `.r-hover`**（例如铺满画布的 `<rect fill="transparent">` 或
  `opacity:0` 的背板）：它会把分组的包围盒撑满画布，命中矩形随之接近整窗，旁边的空白就又会误触发。
  命中判定不看像素透明度，看的是盒子的范围。
- 装饰想参与命中就放在 `.r-hover` 里（例如天线光晕：它会让矩形多覆盖一小圈，属预期）；
  不想参与命中就放到分组外。
- 命中矩形按**渲染盒子**算，与「看不看得见」无关：
  `visibility: hidden` 仍占几何 → 包围盒不变（命中照旧覆盖它）；
  `display: none` 会让元素**退出布局** → 分组包围盒可能随之缩小（实测把 `.r-head` 设成
  `display:none` 后包围盒左/上边界都变了），所以别指望用 `display:none` 精确调命中范围。
  想让某个装饰既不显示也不占命中，请直接移出分组。
- 皮肤缺 `.r-hover` **不再是错误**：矩形退回 `.pet-scale` 的包围盒，功能照常，**不告警**。

修改自带 SVG 的皮肤后，建议跑一次命中区回归（合成指针事件端到端校验）：

```bash
npm run build && node scripts/probe-hover.mjs
```

### 粒子特效钩子（放在 `.r-fx` 分组内）

特效元素是 SVG 的一部分，这样才能在任何体型缩放下都紧贴机器人。**必须用 SVG 坐标定位**
（viewBox `0 0 240 280`）；带 `transform` 动画的元素要用 `<g transform="translate(x,y)">` 包裹定位，
把 CSS class 挂在内部元素上（CSS transform 会覆盖元素自身的 transform 属性）。

| class | 状态 | 作用 |
| --- | --- | --- |
| `.fx-steam`（s1–s4） | 中载/重载 | 蒸汽圆点（cx/cy 定位） |
| `.fx-sweat`（w1–w2） | 中载/重载 | 汗滴（g translate 定位） |
| `.fx-speed`（l1–l3） | 重载 | 速度线 |
| `.fx-zzz`（z1–z3） | 睡觉 | Zzz 文字 |
| `.fx-alert` | 离线 | 感叹号气泡（含 .fx-alert-bg/-tail/-text） |

不提供 `robot.svg` 时，仅替换配色与动画节奏 —— 写个 skin.json 就够了。
