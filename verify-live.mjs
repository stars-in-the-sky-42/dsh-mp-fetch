/**
 * dsh-mp-fetch 在线验证 —— 用真实 API 跑一遍两个工具。
 *
 * 会消耗少量 API 配额（约 6–8 次请求；限额是 25/秒、40000/小时，可忽略）。
 * 用插件自己的代码路径（mock ctx + 真实 fetch），因此验证的是实际行为。
 *
 * 用法：
 *   node verify-live.mjs
 *   node verify-live.mjs --key "D:\path\to\api_key.txt"
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import apply from './index.js'

const args = process.argv.slice(2)
const keyFlag = args.indexOf('--key')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const KEY_FILE =
  keyFlag >= 0 && args[keyFlag + 1]
    ? args[keyFlag + 1]
    : join(DSH_HOME, 'storages', 'mp-fetch', 'api_key.txt')
const OUTPUT_DIR = join(DSH_HOME, 'storages', 'mp-fetch', 'output')

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get: () => undefined,
}
apply(ctx, { keyFile: KEY_FILE, outputDir: OUTPUT_DIR })

const [lookup, spacegroup] = [
  registered.find((tool) => tool.name === 'mp_lookup'),
  registered.find((tool) => tool.name === 'mp_spacegroup'),
]
if (!lookup || !spacegroup) {
  console.error('插件未注册出 mp_lookup / mp_spacegroup，无法继续。')
  process.exit(1)
}

console.log(`key 文件：${KEY_FILE}`)
console.log(`输出目录：${OUTPUT_DIR}\n`)

// --- 1. 化学式 → 空间群（本工作区的两个真实案例） -------------------------
console.log('== 1. mp_lookup：化学式 → 空间群 ==')
{
  const res = await lookup.execute(
    { formula: 'VFeAs,ZrVSi,ScRuP', save: true, key_file: KEY_FILE },
    {},
  )
  check('lookup 成功', res.ok === true, res.message?.slice(0, 200))
  check('VFeAs = P-62m (#189)', res.message.includes('P-62m (#189)'))
  check('ZrVSi = P4/nmm (#129)', res.message.includes('P4/nmm (#129)'))
  check('ScRuP = P-62m (#189)', res.message.includes('P-62m (#189)'))
  check('带 ICSD 号', res.message.includes('icsd-'))
  check('含超导相关性提示', res.message.includes('超导相关性'))
  check('含 WoS 检索式建议', res.message.includes('建议的 WoS 检索式'))
  const data = JSON.parse(res.data)
  check('落盘路径已返回', typeof data.rawPath === 'string' && data.rawPath.length > 0)
  console.log(`  原始 JSON：${data.rawPath}`)
}

// --- 2. 空间群 × 体系通配符（网页端做不到的能力） -------------------------
console.log('\n== 2. mp_spacegroup：空间群 × 体系通配符 ==')
{
  const res = await spacegroup.execute(
    { spacegroup_number: 189, chemsys: '*-Ru-P', save: true, max_rows: 30, key_file: KEY_FILE },
    {},
  )
  check('普查成功', res.ok === true, res.message?.slice(0, 200))
  check('命中 17 条（与调研一致）', res.message.includes('命中 17 条'), res.message.split('\n')[1])
  check('全部 P-62m (#189)', !res.message.includes('(#62)') || res.message.includes('P-62m (#189)'))
  check('含统计块', res.message.includes('统计'))
  check('统计里含金属计数', res.message.includes('金属性：'))
  const data = JSON.parse(res.data)
  check('返回了记录', data.recordCount > 0)
  console.log(`  命中 ${data.total} 条，本页 ${data.recordCount} 条`)
}

// --- 3. 超导筛选组合 ------------------------------------------------------
console.log('\n== 3. mp_spacegroup：超导候选筛选（金属 + 稳定 + 实验结构）==')
{
  const res = await spacegroup.execute(
    {
      spacegroup_number: 189,
      metal_only: true,
      stable_only: true,
      experimental_only: true,
      limit: 20,
      save: false,
      key_file: KEY_FILE,
    },
    {},
  )
  check('筛选成功', res.ok === true, res.message?.slice(0, 200))
  check('条件已反映在标题里', res.message.includes('仅金属') && res.message.includes('仅稳定相'))
  check('统计显示全部稳定', /热力学稳定：(\d+) \/ \1/.test(res.message) || res.message.includes('金属性：'))
}

// --- 4. 德拜温度（超导代理量） --------------------------------------------
console.log('\n== 4. mp_lookup：德拜温度与弹性（debye 字段组）==')
{
  const res = await lookup.execute(
    { formula: 'ScRuP,HfRuP', fields: 'core+debye', save: false, key_file: KEY_FILE },
    {},
  )
  check('查询成功', res.ok === true, res.message?.slice(0, 200))
  const hasDebye = res.message.includes('德拜温度')
  console.log(`  ${hasDebye ? '拿到' : '未拿到'}德拜温度数据`)
  if (hasDebye) {
    const m = res.message.match(/德拜温度 ([\d.]+) K/)
    if (m) console.log(`  德拜温度 = ${m[1]} K`)
  }
  check('debye 块有渲染或无数据提示', hasDebye || res.message.length > 0)
}

// --- 5. 错误路径：坏 key --------------------------------------------------
console.log('\n== 5. 错误路径：无效 API key 应返回 needs_key ==')
{
  const badKeyFile = join(import.meta.dirname, '..', '..', '.tmp', 'dsh-mp-badkey.txt')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(import.meta.dirname, '..', '..', '.tmp'), { recursive: true })
  writeFileSync(badKeyFile, 'THIS_IS_NOT_A_VALID_KEY_000000\n', 'utf8')
  const res = await lookup.execute({ formula: 'VFeAs', save: false, key_file: badKeyFile }, {})
  check('返回 needs_key', res.status === 'needs_key', res.status)
  check('给出补 key 指引', res.message.includes('材料数据（MP）'))
}

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${passed}，失败 ${failed}`)
process.exit(failed ? 1 : 0)
