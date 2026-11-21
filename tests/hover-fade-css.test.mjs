import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/robot/robot.css'), 'utf8')

/**
 * 断言按「逗号分支」逐条比对，而不是对整串选择器做 includes：
 * `.a, .a:hover` 这种分组里有一条写错，整串 includes 仍然命中 → 假阳性。
 */

/** 剥掉注释：注释里为说明会写出选择器与 :has()，不能当真实规则参与校验 */
const CSS_RULES_ONLY = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 顶层规则切分（只收深度 0 的普通样式规则，@keyframes 整段不展开） */
function parseRules(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '')
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
          body: src.slice(bodyStart, i)
        })
        preludeStart = i + 1
      }
    }
  }
  return rules
}

/** 按顶层分隔符切分（括号内的逗号/空格不算），返回 [{branch, rule}] */
function splitTopLevel(text, separators) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && separators.includes(ch)) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 复合选择器的「主体」= 最后一个组合器之后的部分（决定这条规则作用在谁身上） */
function subjectOf(selector) {
  const parts = splitTopLevel(selector, ' >+~')
  return (parts[parts.length - 1] || '').trim()
}

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
const BRANCHES = RULES.flatMap((rule) => splitTopLevel(rule.selector, ',').map((branch) => ({ branch, rule })))
const declsOf = (rule) => decls(rule.body)

/** 悬停淡化相关的规则：命中锚点、启用开关、以及任何使用 --hover-opacity 的规则 */
const HOVER_RELATED = RULES.filter(
  (rule) =>
    rule.selector.includes('hover-fade-enabled') ||
    rule.selector.includes(':has(.r-hover') ||
    declsOf(rule).some((d) => d.includes('var(--hover-opacity'))
)

const HOVER_BRANCH = /^\.pet-stage\.hover-fade-enabled:has\(\.r-hover:hover\)\s+\.pet-(scale|shadow)$/

test('命中：.r-hover:hover 通过独立分支分别淡化 .pet-scale 与 .pet-shadow', () => {
  for (const target of ['.pet-scale', '.pet-shadow']) {
    const branch = BRANCHES.find((b) => b.branch === `.pet-stage.hover-fade-enabled:has(.r-hover:hover) ${target}`)
    assert.ok(branch, `缺少独立分支："${`.pet-stage.hover-fade-enabled:has(.r-hover:hover) ${target}`}"（逗号分组里混进 :hover 之类的改动必须被抓住）`)
    assert.match(branch.branch, HOVER_BRANCH)
    assert.equal(subjectOf(branch.branch), target, `该分支的主体必须正好是 ${target}`)

    const d = declsOf(branch.rule)
    assert.ok(d.includes('opacity:var(--hover-opacity, 0.4)'), `${target} 悬停规则须写入 opacity: var(--hover-opacity, 0.4)`)
    assert.ok(d.includes('transition-delay:0ms'), `${target} 悬停规则须用 transition-delay: 0ms 让进入立刻开始`)
  }
})

test('过渡：挂在「未触发也成立」的独立分支上，160ms 淡出 + 180ms 离开宽限', () => {
  for (const target of ['.pet-scale', '.pet-shadow']) {
    const branch = BRANCHES.find((b) => b.branch === `.pet-stage.hover-fade-enabled ${target}`)
    assert.ok(branch, `缺少常驻过渡分支："${`.pet-stage.hover-fade-enabled ${target}`}"`)
    assert.equal(subjectOf(branch.branch), target)
    assert.ok(!branch.branch.includes(':hover'), '过渡规则不能依赖 :hover，否则离开悬停时没有过渡可跑')
    assert.ok(
      declsOf(branch.rule).includes('transition:opacity 160ms ease 180ms'),
      `${target} 过渡须是 "opacity 160ms ease 180ms"`
    )
  }
})

test('淡化主体白名单：悬停淡化的每条分支只能作用在 .pet-scale / .pet-shadow 上', () => {
  assert.ok(HOVER_RELATED.length >= 2, '找不到悬停淡化规则')
  const bad = []
  for (const rule of HOVER_RELATED) {
    for (const branch of splitTopLevel(rule.selector, ',')) {
      const subject = subjectOf(branch)
      if (subject !== '.pet-scale' && subject !== '.pet-shadow') bad.push(branch)
    }
  }
  // 整舞台/状态文字/设置面板被淡化（例如 .pet-stage.hover-fade-enabled:has(...) { opacity } ）必须在此报红
  assert.deepEqual(bad, [], `这些分支把淡化作用到了 .pet-scale / .pet-shadow 之外：${bad.join(' | ')}`)
})

test('不透明度声明只有一处形态：var(--hover-opacity, 0.4)，且不得用 !important 硬压', () => {
  const badDecls = []
  const badImportant = []
  for (const rule of HOVER_RELATED) {
    for (const d of declsOf(rule)) {
      if (d.startsWith('opacity:')) {
        if (d !== 'opacity:var(--hover-opacity, 0.4)') badDecls.push(`${rule.selector} → ${d}`)
      }
      if (d.includes('!important')) badImportant.push(`${rule.selector} → ${d}`)
    }
  }
  assert.deepEqual(badDecls, [], `不透明度声明形态不对（会破坏「允许 0%」或让变量失效）：${badDecls.join(' | ')}`)
  // 追加 opacity: 1 !important（或任何 !important）都会让淡化的胜负反转 → 在此报红
  assert.deepEqual(badImportant, [], `悬停淡化规则里不允许 !important：${badImportant.join(' | ')}`)
})

test('不透明度变量只被 .pet-scale / .pet-shadow 消费（不许挂到舞台或子元素上）', () => {
  const consumers = BRANCHES.filter(({ rule }) => declsOf(rule).some((d) => d.includes('var(--hover-opacity')))
  assert.ok(consumers.length > 0, '找不到 --hover-opacity 的使用点')
  const bad = consumers.filter(({ branch }) => !['.pet-scale', '.pet-shadow'].includes(subjectOf(branch)))
  assert.deepEqual(bad.map((b) => b.branch), [], '--hover-opacity 只能写在 .pet-scale / .pet-shadow 的规则里')
})

test('不得用舞台/缩放层/SVG 根做命中判定（旁边空白误触发的成因）', () => {
  const forbidden = /^\.(pet-stage|pet-scale|r-svg)(\.[\w-]+)*(::?[\w-]+(\([^)]*\))?)*:hover/
  const hit = BRANCHES.filter(({ branch }) => forbidden.test(branch) || /\.pet-stage:has\(:hover\)/.test(branch))
  assert.deepEqual(hit.map((b) => b.branch), [], '出现了以舞台/缩放层/SVG 根为命中区的规则')

  // :has() 的参数只能是 .r-hover（可带 :hover），不能放宽到别的元素
  const args = [...CSS_RULES_ONLY.matchAll(/:has\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(args.length > 0, '找不到 :has() 悬停规则')
  for (const arg of args) {
    assert.match(arg, /^\.r-hover(\s*:hover|:hover)?$/, `:has() 参数只允许锚定 .r-hover，实际：${arg}`)
  }
})

test('天线光晕排除出命中区：柔光不可见却能触发，属于精度漏洞', () => {
  const glow = BRANCHES.filter(({ branch }) => subjectOf(branch) === '.r-antenna-glow')
  assert.ok(glow.length > 0, '找不到 .r-antenna-glow 规则')
  assert.ok(
    glow.some(({ rule }) => declsOf(rule).includes('pointer-events:none')),
    '.r-antenna-glow 须设置 pointer-events: none（否则灯泡周围一圈柔光会误触发）'
  )
})

test('状态文字与设置面板不参与淡化', () => {
  const touched = BRANCHES.filter(({ branch }) => /\.pet-status|\.pet-settings/.test(branch))
  for (const { branch, rule } of touched) {
    assert.ok(
      !declsOf(rule).some((d) => d.startsWith('opacity:var(--hover-opacity')),
      `状态文字/设置面板不得使用悬停淡化变量：${branch}`
    )
  }
})
