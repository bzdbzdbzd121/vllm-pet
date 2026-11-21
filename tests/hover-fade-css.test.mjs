import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/robot/robot.css'), 'utf8')

/**
 * 极简 CSS 规则切分：只收集顶层（深度 0）规则，@keyframes 的嵌套块被当整段 body，
 * 不进结果里逐条展开（我们只关心普通样式规则的声明）。
 * 先剥掉注释：注释里为了说明会提到 :has() 与禁止的选择器，不能当真实规则去校验。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseRules(source) {
  const src = stripComments(source)
  const rules = []
  let depth = 0
  let preludeStart = 0
  let bodyStart = -1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        rules.push({
          selector: src.slice(preludeStart, bodyStart - 1).trim().replace(/\s+/g, ' '),
          body: src.slice(bodyStart, i),
          index: rules.length
        })
        preludeStart = i + 1
      }
    }
  }
  return rules
}

/** 把声明块拆成 ['prop:value', ...]（去注释、压缩空白、小写属性名） */
function decls(body) {
  return body
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':')
      return i < 0 ? d.toLowerCase() : `${d.slice(0, i).trim().toLowerCase()}:${d.slice(i + 1).trim()}`
    })
}

const RULES = parseRules(CSS)
const CSS_RULES_ONLY = stripComments(CSS)
const withDecl = (prop, value) =>
  RULES.filter((r) => decls(r.body).some((d) => (value === undefined ? d.startsWith(`${prop}:`) : d === `${prop}:${value}`)))

const HOVER_SEL = ':has(.r-hover:hover)'

test('命中区锚定 .r-hover：悬停规则命中本体时淡化 .pet-scale 与 .pet-shadow', () => {
  for (const target of ['.pet-scale', '.pet-shadow']) {
    const rule = RULES.find(
      (r) => r.selector.includes(HOVER_SEL) && r.selector.includes('.hover-fade-enabled') && r.selector.includes(target)
    )
    assert.ok(rule, `缺少锚定 .r-hover 且作用于 ${target} 的悬停规则`)
    assert.ok(decls(rule.body).includes('opacity:var(--hover-opacity, 0.4)'), `${target} 悬停规则须写入 opacity: var(--hover-opacity, 0.4)`)
    assert.ok(decls(rule.body).includes('transition-delay:0ms'), `${target} 悬停规则须用 transition-delay: 0ms 让进入立刻开始`)
  }
})

test('过渡写在「未触发」也成立的规则上，否则离开没有过渡；离开宽限 180ms、淡出 160ms', () => {
  for (const target of ['.pet-scale', '.pet-shadow']) {
    const rule = RULES.find(
      (r) => r.selector.includes('.hover-fade-enabled') && r.selector.includes(target) && !r.selector.includes(':hover')
    )
    assert.ok(rule, `缺少 ${target} 的常驻过渡规则`)
    assert.ok(
      decls(rule.body).includes('transition:opacity 160ms ease 180ms'),
      `${target} 过渡须是 "opacity 160ms ease 180ms"（160ms 淡出 + 180ms 离开宽限）`
    )
  }
})

test('淡化的 class 必须挂在 .pet-stage 上（关闭开关即立刻恢复，不做 180ms 等待）', () => {
  const hoverish = RULES.filter((r) => r.selector.includes(HOVER_SEL))
  assert.ok(hoverish.length >= 1, '缺少锚定 .r-hover 的悬停规则')
  for (const r of hoverish) {
    for (const sel of r.selector.split(',')) {
      assert.match(sel.trim(), /^\.pet-stage\.hover-fade-enabled/, `悬停规则选择器起点必须是 .pet-stage.hover-fade-enabled，实际：${sel.trim()}`)
    }
  }
})

test('不得用舞台/缩放层/SVG 根做命中判定（那正是旁边空白误触发的成因）', () => {
  const forbidden = [/\.pet-stage:hover/, /\.pet-scale:hover/, /\.r-svg:hover/, /\.pet-stage:has\(:hover\)/]
  const hit = RULES.filter((r) => forbidden.some((re) => re.test(r.selector)))
  assert.deepEqual(hit.map((r) => r.selector), [], '出现了以舞台/缩放层/SVG 根为命中区的规则')

  // :has() 的参数只能是 .r-hover，不能放宽到别的元素
  const args = [...CSS_RULES_ONLY.matchAll(/:has\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(args.length > 0, '找不到 :has() 悬停规则')
  for (const arg of args) {
    assert.match(arg, /^\.r-hover(\s*:hover)?$/, `:has() 参数只允许锚定 .r-hover，实际：${arg}`)
  }
})

test('天线光晕排除出命中区：柔光不可见却能触发，属于精度漏洞', () => {
  const glow = RULES.filter((r) => /(^|[\s,])\.r-antenna-glow(\s|,|$)/.test(r.selector))
  assert.ok(glow.length > 0, '找不到 .r-antenna-glow 规则')
  assert.ok(
    glow.some((r) => decls(r.body).includes('pointer-events:none')),
    '.r-antenna-glow 须设置 pointer-events: none（否则灯泡周围一圈柔光会误触发）'
  )
})

test('状态文字与设置面板不会被淡化：不透明度只写在 .pet-scale / .pet-shadow 上', () => {
  const hoverRules = RULES.filter((r) => r.selector.includes(HOVER_SEL) || r.selector.includes('.hover-fade-enabled'))
  for (const r of hoverRules) {
    assert.doesNotMatch(r.selector, /pet-status|pet-settings|pet-stage\s*$/, `悬停规则不得作用于状态文字/设置面板/舞台本身：${r.selector}`)
    // 允许 transition 出现在常驻规则里；opacity 只允许出现在悬停规则上
    if (!r.selector.includes(HOVER_SEL)) {
      assert.ok(!decls(r.body).includes('opacity:var(--hover-opacity, 0.4)'), `opacity 只该写在悬停规则里：${r.selector}`)
    }
  }
})

test('不透明度由 CSS 变量驱动，默认 0.4，与配置归一化默认值一致', () => {
  assert.match(CSS_RULES_ONLY, /var\(--hover-opacity,\s*0\.4\)/, '悬停不透明度须用 var(--hover-opacity, 0.4) 驱动')
})
