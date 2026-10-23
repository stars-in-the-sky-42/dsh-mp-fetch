/**
 * dsh-mp-fetch 离线自检 —— 不联网、不消耗 API 配额。
 *
 * 覆盖：
 *   1. key 文件的解析（纯 key / 只有模板 / 带注释）
 *   2. 字段组解析与空间群渲染
 *   3. 查询参数拼装（含 experimental_only → theoretical=false 这类映射）
 *   4. 插件注册（两个工具、apply.inject 挂载）
 *   5. 两个工具的 execute 端到端（fetch 打桩）
 *   6. 错误路径：缺少条件、401 鉴权失败、通配符 + 多体系
 *
 * 用法：node selftest.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EP, joinQuery, MpError, request } from './mp.js'
import {
  formatCensusTable,
  formulaVariants,
  keyPropsText,
  resolveFieldSelection,
  spaceGroupText,
} from './fields.js'
import { isTemplateOnly, parseKeyText } from './key-store.js'
import apply from './index.js'

let passed = 0
let failed = 0
const failures = []

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

// ---------------------------------------------------------------- fixtures
const VFEAS = {
  material_id: 'mp-1095040',
  formula_pretty: 'VFeAs',
  formula_anonymous: 'ABC',
  chemsys: 'As-Fe-V',
  elements: ['As', 'Fe', 'V'],
  nelements: 3,
  symmetry: {
    crystal_system: 'Hexagonal',
    symbol: 'P-62m',
    number: 189,
    point_group: '-6m2',
  },
  theoretical: false,
  database_IDs: { icsd: ['icsd-610532'] },
  is_stable: false,
  energy_above_hull: 0.006080895833334488,
  is_metal: true,
  band_gap: 0,
  is_magnetic: true,
  ordering: 'FM',
  total_magnetization: 2.5,
  nsites: 9,
  volume: 117.1,
  density: 7.73,
  deprecated: false,
  last_updated: '2026-05-30T04:47:30.391000',
  has_props: { materials: true, thermo: true, dos: true, magnetism: true, phonon: false, elasticity: false },
}

const ZRVSI = {
  material_id: 'mp-5541',
  formula_pretty: 'ZrVSi',
  chemsys: 'Si-V-Zr',
  elements: ['Si', 'V', 'Zr'],
  nelements: 3,
  symmetry: { crystal_system: 'Tetragonal', symbol: 'P4/nmm', number: 129, point_group: '4/mmm' },
  theoretical: false,
  database_IDs: { icsd: ['icsd-652544', 'icsd-42337'] },
  is_stable: true,
  energy_above_hull: 0,
  is_metal: true,
  band_gap: 0,
  is_magnetic: false,
  ordering: 'Unknown',
  nsites: 6,
  volume: 97.96,
  density: 5.77,
  deprecated: false,
  has_props: { materials: true, thermo: true, dos: true, phonon: false, elasticity: false },
}

const ZRRUP_189 = {
  material_id: 'mp-1178620',
  formula_pretty: 'ZrRuP',
  chemsys: 'P-Ru-Zr',
  elements: ['P', 'Ru', 'Zr'],
  nelements: 3,
  symmetry: { crystal_system: 'Hexagonal', symbol: 'P-62m', number: 189, point_group: '-6m2' },
  theoretical: false,
  database_IDs: { icsd: ['icsd-648037', 'icsd-189960'] },
  is_stable: false,
  energy_above_hull: 0.016286850277777987,
  is_metal: true,
  is_magnetic: false,
  ordering: 'NM',
  nsites: 9,
  has_props: { materials: true, thermo: true, dos: true, magnetism: true, phonon: false, elasticity: false },
}

/** 造一个最小的 Response 替身，够 mp.js 用即可。 */
function fakeResponse(json, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h.has(name) ? h.get(name) : null) },
    async json() {
      return json
    },
    async text() {
      return JSON.stringify(json)
    },
  }
}

function metaEnvelope(data, total, extra = {}) {
  return {
    data,
    meta: {
      api_version: 'test-0.0.0',
      total_doc: total,
      max_limit: 1000,
      ...extra,
    },
  }
}

// ------------------------------------------------------------------- tests
section('1. key 文件解析')
eq('纯 key', parseKeyText('zTd3EIKUvPgkakUn0lFmOskZtxf0N88M'), 'zTd3EIKUvPgkakUn0lFmOskZtxf0N88M')
eq('带注释 + key', parseKeyText('# 说明\n# 更多说明\nABC123\n'), 'ABC123')
eq('只有模板 → null', parseKeyText('# 只有说明\n# 没有 key\n'), null)
eq('空文件 → null', parseKeyText('   \n\n'), null)
eq('容忍前后空白', parseKeyText('  KEYVALUE  \n'), 'KEYVALUE')
ok('isTemplateOnly(模板) = true', isTemplateOnly('# 说明\n'))
ok('isTemplateOnly(纯 key) = false', isTemplateOnly('SOMEKEY') === false)

section('2. 字段组解析')
const selCore = resolveFieldSelection('core')
ok('core 含空间群字段', selCore.summaryFields.includes('symmetry'))
ok('core 含 ICSD 字段', selCore.summaryFields.includes('database_IDs'))
ok('core 默认带 props', selCore.summaryFields.includes('has_props'))
ok('core 默认不带 structure', selCore.includeStructure === false)
ok('core 无 extras', selCore.extras.length === 0)

const selMix = resolveFieldSelection('thermo+debye+structure')
ok('thermo 生效', selMix.summaryFields.includes('formation_energy_per_atom'))
ok('debye 进入 extras', selMix.extras.includes('debye'))
ok('structure 打开开关', selMix.includeStructure === true)

const selAll = resolveFieldSelection('all')
ok('all 覆盖 extras', selAll.extras.length >= 5)
ok('all 含 structure', selAll.includeStructure === true)

const selBad = resolveFieldSelection('nosuchgroup')
ok('未知字段组被记录', selBad.unknown.includes('nosuchgroup'))

section('3. 渲染')
eq('空间群渲染', spaceGroupText(VFEAS), 'P-62m (#189)')
eq('空间群渲染（四方）', spaceGroupText(ZRVSI), 'P4/nmm (#129)')
eq('空间群缺省', spaceGroupText({}), '（无）')
ok('关键属性只列超导四项', keyPropsText(VFEAS) === 'dos/magnetism', keyPropsText(VFEAS))

const table = formatCensusTable([VFEAS, ZRVSI], { maxRows: 10 })
ok('普查表含表头空间群', table.includes('空间群'))
ok('普查表含 VFeAs', table.includes('VFeAs'))
ok('普查表含 ICSD', table.includes('icsd-610532'))
ok('普查表把 theoretical=false 渲染成"实验"', table.includes('实验'))
ok('空结果有提示', formatCensusTable([]).includes('没有命中'))

section('3b. 元素顺序排列（材料总纲 R8）')
{
  // ScRuP：MP 会写成 ScPRu，检索必须覆盖全部 6 种排列
  const scrup = {
    formula_pretty: 'ScPRu',
    elements: ['P', 'Ru', 'Sc'],
    composition_reduced: { P: 1, Ru: 1, Sc: 1 },
  }
  const v = formulaVariants(scrup)
  ok('111 型也能生出多种排列', v.length > 1, `得到 ${v.length} 种：${v.join('/')}`)
  ok('MP 写法排在第一位', v[0] === 'ScPRu', v.join('/'))
  ok('含惯用写法 ScRuP', v.includes('ScRuP'), v.join('/'))
  ok('排列已去重', new Set(v).size === v.length, v.join('/'))

  // 612 型：化学计量数要保留
  const sc6 = {
    formula_pretty: 'Sc6RuSb2',
    elements: ['Sc', 'Ru', 'Sb'],
    composition_reduced: { Sc: 6, Ru: 1, Sb: 2 },
  }
  const v6 = formulaVariants(sc6)
  ok('计量数 >1 时保留数字', v6.includes('Sc6RuSb2'), v6.join('/'))
  ok('其它排列也保留计量数', v6.some((f) => f === 'Sc6Sb2Ru' || f === 'RuSc6Sb2'), v6.join('/'))

  // 单元素 / 元素过多时退化
  ok('单元素退化为单写法', formulaVariants({ formula_pretty: 'Fe', elements: ['Fe'] }).length === 1)
  ok(
    '超过 4 元素退化为单写法',
    formulaVariants({
      formula_pretty: 'ABCDE',
      elements: ['A', 'B', 'C', 'D', 'E'],
      composition_reduced: {},
    }).length === 1,
  )
  ok('无元素信息时用 formula_pretty', formulaVariants({ formula_pretty: 'XYZ' })[0] === 'XYZ')
}

section('4. 查询拼装')
const qs = joinQuery({ a: 1, b: true, c: false, d: ['x', 'y'], e: null, f: undefined, g: '' })
eq('数字', qs.get('a'), '1')
eq('true', qs.get('b'), 'true')
eq('false', qs.get('c'), 'false')
eq('数组用逗号连接', qs.get('d'), 'x,y')
eq('null 被跳过', qs.get('e'), null)
eq('undefined 被跳过', qs.get('f'), null)
eq('空串被跳过', qs.get('g'), null)

section('5. 插件注册（mock ctx）')
const registered = []
const mockCtx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get: () => undefined,
}
const tmpRoot = join(import.meta.dirname, '..', '..', '.tmp')
mkdirSync(tmpRoot, { recursive: true })
const dispose = apply(mockCtx, {
  keyFile: join(tmpRoot, 'dsh-mp-selftest-key.txt'),
  outputDir: join(tmpRoot, 'dsh-mp-selftest-out'),
})
eq('注册了 3 个工具', registered.length, 3)
eq('第一个是 mp_lookup', registered[0].name, 'mp_lookup')
eq('第二个是 mp_spacegroup', registered[1].name, 'mp_spacegroup')
eq('第三个是 mp_habits', registered[2].name, 'mp_habits')
ok('mp_lookup 有 execute', typeof registered[0].execute === 'function')
ok('mp_spacegroup 有 execute', typeof registered[1].execute === 'function')
ok('apply.inject 已挂载', Array.isArray(apply.inject) && apply.inject.includes('tools'))
ok('dispose 是函数', typeof dispose === 'function')

const [lookupTool, sgTool] = registered

// 把真实 key 文件写出来，好让 loadKey 走成功路径
const keyDir = mkdtempSync(join(tmpRoot, 'dsh-mp-selftest-'))
const keyFile = join(keyDir, 'api_key.txt')
writeFileSync(keyFile, 'TESTSELFTESTKEY0123456789abcdef\n', 'utf8')
ok('临时 key 文件已就绪', existsSync(keyFile))

section('6. mp_lookup 端到端（fetch 打桩）')
const realFetch = globalThis.fetch
let lastUrl = null

globalThis.fetch = async (url) => {
  lastUrl = String(url)
  if (url.includes('/materials/summary/')) {
    const wantsVFeAs = url.includes('VFeAs')
    const data = wantsVFeAs ? [VFEAS] : [ZRVSI]
    return fakeResponse(metaEnvelope(data, data.length), {
      headers: { 'X-RateLimit-Remaining-Second': '24', 'X-RateLimit-Remaining-Hour': '39999' },
    })
  }
  if (url.includes('/materials/elasticity/')) {
    return fakeResponse(
      metaEnvelope(
        [
          {
            material_id: 'mp-16305',
            formula_pretty: 'ScPRu',
            debye_temperature: 531.34,
            sound_velocity: { transverse: 3971.28, longitudinal: 6933.55 },
            bulk_modulus: { vrh: 175.386 },
            shear_modulus: { vrh: 102.271 },
          },
        ],
        1,
      ),
    )
  }
  return fakeResponse(metaEnvelope([], 0))
}

try {
  const res = await lookupTool.execute({ formula: 'VFeAs', save: false, key_file: keyFile }, {})
  eq('lookup ok', res.ok, true)
  eq('lookup status', res.status, 'ok')
  ok('lookup 带上 id_format=legacy', lastUrl.includes('id_format=legacy'), lastUrl.slice(0, 120))
  ok('lookup 用了 formula 参数', lastUrl.includes('formula=VFeAs'))
  ok('lookup 消息含空间群', res.message.includes('P-62m (#189)'))
  ok('来源渲染成"实验"而非布尔', res.message.includes('来源：实验'), res.message.match(/来源：\S+/)?.[0])
  ok('不再出现"来源：否"', !res.message.includes('来源：否'))
  ok('元素数组渲染成逗号分隔', res.message.includes('元素：As, Fe, V'), res.message.match(/元素：.+/)?.[0])
  ok('元素没有 JSON 方括号', !res.message.includes('["As"'))
  ok('详情块默认只列超导相关属性', res.message.includes('★态密度'), res.message.match(/可用属性：.+/)?.[0])
  ok('默认不列无关属性位（如晶界）', !res.message.includes('★晶界') && !res.message.includes('、晶界'))
  ok('lookup 消息含 ICSD', res.message.includes('icsd-610532'))
  ok('lookup 消息含超导相关性提示', res.message.includes('超导相关性'))
  ok('lookup 消息含 WoS 检索式建议', res.message.includes('建议的 WoS 检索式'))
  ok('lookup 未写盘（save=false）', !res.message.includes('原始 JSON：'))
  const parsed = JSON.parse(res.data)
  eq('lookup data.recordCount', parsed.recordCount, 1)
  ok('lookup 不回显 key 本体', !res.message.includes('TESTSELFTESTKEY'), '消息里出现了 key！')

  const withExtras = await lookupTool.execute(
    { formula: 'ScRuP', fields: 'core+debye', save: false, key_file: keyFile },
    {},
  )
  ok('debye 组触发 elasticity 端点', lastUrl.includes('/materials/elasticity/'))
  ok('debye 请求带 _fields 投影', lastUrl.includes('debye_temperature'), lastUrl.slice(0, 200))
  ok('debye 请求带 id_format=legacy', lastUrl.includes('id_format=legacy'))
  ok('debye 块渲染德拜温度', withExtras.message.includes('德拜温度 531.3 K'), withExtras.message.slice(-400))

  // elasticity 返回空字段时应明说，而不是显示一排破折号
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.includes('/materials/elasticity/')) {
      return fakeResponse(metaEnvelope([{ material_id: 'mp-1', formula_pretty: 'NoElast' }], 1))
    }
    return fakeResponse(metaEnvelope([VFEAS], 1))
  }
  const noElast = await lookupTool.execute(
    { formula: 'VFeAs', fields: 'core+debye', save: false, key_file: keyFile },
    {},
  )
  ok('无弹性数据时明确说明', noElast.message.includes('无弹性数据'), noElast.message.slice(-300))
  globalThis.fetch = savedFetch

  // 参数映射
  lastUrl = null
  await lookupTool.execute(
    { formula: 'VFeAs', experimental_only: true, stable_only: true, metal_only: true, save: false, key_file: keyFile },
    {},
  )
  ok('experimental_only → theoretical=false', lastUrl.includes('theoretical=false'))
  ok('stable_only → is_stable=true', lastUrl.includes('is_stable=true'))
  ok('metal_only → is_metal=true', lastUrl.includes('is_metal=true'))

  section('7. mp_spacegroup 端到端（fetch 打桩）')
  lastUrl = null
  const sg = await sgTool.execute(
    { spacegroup_number: 189, chemsys: '*-Ru-P', save: false, key_file: keyFile },
    {},
  )
  eq('普查 ok', sg.ok, true)
  ok('普查带上空间群号', lastUrl.includes('spacegroup_number=189'))
  ok('普查带上通配体系', lastUrl.includes('chemsys=%2A-Ru-P') || lastUrl.includes('chemsys=*-Ru-P'))
  ok('普查消息含统计', sg.message.includes('统计'))
  ok('普查消息含晶系分布', sg.message.includes('晶系分布'))
  ok('普查消息含元素分布', sg.message.includes('元素分布'))
  ok('普查消息含金属计数', sg.message.includes('金属性：'))
  const sgData = JSON.parse(sg.data)
  ok('普查 data 带 total', typeof sgData.total === 'number')

  section('8. 错误路径')
  const noArgs = await lookupTool.execute({ save: false, key_file: keyFile }, {})
  eq('lookup 无参数 → error', noArgs.status, 'error')
  ok('lookup 无参数给出提示', noArgs.message.includes('至少要给一个条件'))

  const sgNoArgs = await sgTool.execute({ save: false, key_file: keyFile }, {})
  eq('普查无空间群 → error', sgNoArgs.status, 'error')
  ok('普查无空间群指向 mp_lookup', sgNoArgs.message.includes('mp_lookup'))

  const badWildcard = await sgTool.execute(
    { spacegroup_number: 189, chemsys: '*-Ru-P,*-Fe-P', save: false, key_file: keyFile },
    {},
  )
  eq('通配符+多体系 → error', badWildcard.status, 'error')
  ok('通配符错误说明原因', badWildcard.message.includes('只支持单个体系'))

  const badField = await lookupTool.execute(
    { formula: 'VFeAs', fields: 'nope', save: false, key_file: keyFile },
    {},
  )
  eq('未知字段组 → error', badField.status, 'error')
  ok('未知字段组列出可用项', badField.message.includes('thermo'))

  // 401 鉴权失败
  globalThis.fetch = async () => fakeResponse({ detail: 'unauthorized' }, { status: 401 })
  const unauth = await lookupTool.execute({ formula: 'VFeAs', save: false, key_file: keyFile }, {})
  eq('401 → needs_key', unauth.status, 'needs_key')
  ok('401 给出补 key 指引', unauth.message.includes('材料数据（MP）'))

  // 缺少 key 文件
  const missing = await lookupTool.execute(
    { formula: 'VFeAs', save: false, key_file: join(keyDir, 'does-not-exist.txt') },
    {},
  )
  eq('key 缺失 → needs_key', missing.status, 'needs_key')
  ok('key 缺失提示指向设置页', missing.message.includes('材料数据（MP）'))

  section('9. mp.js 直接调用')
  globalThis.fetch = async () =>
    fakeResponse(metaEnvelope([VFEAS], 1), {
      headers: { 'X-RateLimit-Limit-Second': '25', 'X-RateLimit-Remaining-Second': '24' },
    })
  const direct = await request(EP.summary, { formula: 'VFeAs' }, { apiKey: 'x' })
  eq('request 返回 data', direct.data.length, 1)
  eq('request 返回 total', direct.total, 1)
  eq('request 解析速率头', direct.rateLimit.remainingSecond, 24)

  let threw = null
  try {
    await request(EP.summary, {}, { apiKey: '' })
  } catch (error) {
    threw = error
  }
  ok('空 key 抛 MpError', threw instanceof MpError, String(threw))
} finally {
  globalThis.fetch = realFetch
}

// ------------------------------------------------------------------ report
console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${passed}，失败 ${failed}`)
if (failed) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('离线自检全部通过。')
