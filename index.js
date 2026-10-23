/**
 * dsh-mp-fetch —— Materials Project 查询插件（DSH Host 半）。
 *
 * 提供两个模型可调用的工具：
 *   mp_lookup     按化学式 / MP ID / 化学体系查物性（重点是空间群，便于归档）
 *   mp_spacegroup 按空间群 / 晶系做普查筛选（对应 MP 网页端的空间群筛选，
 *                 并额外支持网页端做不到的 chemsys 通配符）
 *
 * 为什么不用官方的 mp-api（Python）：DSH 插件跑在 Node.js，直连 REST 零依赖；
 * mp-api 依赖 pymgen/pyarrow/deltalake 一大串，Python 3.14 上还有 wheel 风险。
 * 详见 docs/PLAN-mp-plugin.md。
 *
 * 环境变量（可选，覆盖插件 config）：
 *   MP_KEY_FILE, MP_OUTPUT_DIR
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  EP,
  MpError,
  byMaterialIds,
  request,
} from './mp.js'
import {
  EXTRA_FIELDS,
  EXTRA_GROUPS,
  KEY_PROPS,
  allPropsText,
  evidenceText,
  formatCensusTable,
  formatDetail,
  formulaVariants,
  icsdText,
  isNonCentrosymmetric,
  keyPropsText,
  resolveFieldSelection,
  spaceGroupText,
  superconductorNotes,
} from './fields.js'
import {
  defaultKeyFile,
  ensureKeyFile,
  keyHelp,
  readKeyFile,
} from './key-store.js'
import { FALLBACK_KEY_REFS, resolveCredential } from './credentials.js'
import { registerSettingsRoute } from './settings-route.js'
import {
  MAX_HABITS_CHARS,
  readHabits,
  resetHabits,
  writeHabits,
} from './habits.js'
import { dataDir, outputDir } from './settings-store.js'

export const name = 'mp-fetch'

/**
 * 必须声明 inject（注册工具的唯一硬依赖）。
 * cordis 是严格依赖注入：`ctx.tools` 未声明就直接抛错，而 loader 会吞掉异常，
 * 表现为"插件装了但工具不出现"。
 */
export const inject = ['tools']

function loggerOf(ctx) {
  try {
    return ctx.get?.('logger')
  } catch {
    return undefined
  }
}

function logInfo(ctx, message) {
  try {
    loggerOf(ctx)?.info?.(message)
  } catch {
    /* 日志失败不影响功能 */
  }
}

function logWarn(ctx, message) {
  try {
    loggerOf(ctx)?.warn?.(message)
  } catch {
    /* 同上 */
  }
}

export const Config = {
  keyFile: {
    type: 'string',
    description:
      '旧版 API key 文件路径（回退用）。默认 <DSH_HOME>/storages/mp-fetch/api_key.txt；设置页保存的凭据优先。',
  },
  outputDir: {
    type: 'string',
    description: '原始 JSON 的落盘目录。默认 <DSH_HOME>/storages/mp-fetch/output。',
  },
  timeoutMs: {
    type: 'number',
    description: '单次 HTTP 请求超时（毫秒）。默认 60000。',
  },
}

const TOOL_TIMEOUT_MS = 180000

const SHARED_PROPS = {
  fields: {
    type: 'string',
    description:
      '要额外取回的字段组，用 + 或 , 连接。可用：thermo / electronic / magnetism / ' +
      'elastic / surface / structure / props / all，以及需要另打端点的 ' +
      'debye（德拜温度·声速）/ synthesis（文献合成配方）/ robocrys（结构人话描述）/ ' +
      'phonon（声子元信息）/ similarity（结构相似材料）/ provenance（ICSD 交叉引用）/ ' +
      'electronic_full / magnetism_full / thermo_full。默认 core（含空间群、稳定性、金属性、磁性、ICSD）。',
  },
  experimental_only: {
    type: 'boolean',
    description: '只返回结构源自实验的材料（theoretical=false，即有 ICSD 等实验结构）。默认 false。',
  },
  stable_only: {
    type: 'boolean',
    description: '只返回热力学稳定相（energy_above_hull = 0）。默认 false。',
  },
  metal_only: {
    type: 'boolean',
    description: '只返回金属（is_metal=true）。超导筛选常用。默认 false。',
  },
  max_rows: {
    type: 'number',
    description: '返回的表格最多几行。默认 30，避免刷屏。',
  },
  save: {
    type: 'boolean',
    description: '是否把原始 JSON 落盘。默认 true。',
  },
  key_file: {
    type: 'string',
    description: '覆盖 API key 文件路径（一般不需要，插件已配置默认路径）。',
  },
  full_props: {
    type: 'boolean',
    description:
      'has_props 是否展开全部 20 项。默认 false —— 只显示超导相关的四项（声子/弹性/态密度/磁性）。',
  },
}

const LOOKUP_PARAMS = {
  type: 'object',
  properties: {
    formula: {
      type: 'string',
      description: '化学式，如 "VFeAs"；支持逗号分隔多个（"VFeAs,ScRuP"）与通配符。',
    },
    material_ids: {
      type: 'string',
      description: 'MP ID，如 "mp-1095040"（老式）或 "mp-aaackhwy"（新式）；逗号分隔多个。',
    },
    chemsys: {
      type: 'string',
      description:
        '化学体系，如 "V-Fe-As"。支持通配符（"*-Ru-P"、"Zr-*-P"），但通配符只支持单个体系。',
    },
    ...SHARED_PROPS,
  },
  required: [],
}

const SPACEGROUP_PARAMS = {
  type: 'object',
  properties: {
    spacegroup_number: {
      type: 'string',
      description: '空间群号，如 189 或 "189,194"（逗号分隔多个）。',
    },
    spacegroup_symbol: {
      type: 'string',
      description: '空间群符号，如 "P-62m"。',
    },
    crystal_system: {
      type: 'string',
      description: '晶系，如 "Hexagonal" 或 "Hexagonal,Trigonal"。',
    },
    chemsys: {
      type: 'string',
      description: '化学体系（支持通配符，如 "*-Ru-P"），用来在某个空间群里找同体系材料。',
    },
    elements: {
      type: 'string',
      description: '必须包含的元素，逗号分隔，如 "Zr,P"。',
    },
    exclude_elements: {
      type: 'string',
      description: '必须排除的元素，逗号分隔。',
    },
    formula: {
      type: 'string',
      description: '化学式过滤（支持通配符）。',
    },
    nelements: {
      type: 'number',
      description: '元素数，如 3 表示只找三元化合物。',
    },
    sort: {
      type: 'string',
      description:
        '排序字段，前缀 - 表示降序。如 "energy_above_hull"、"-nsites"、"-formation_energy_per_atom"。',
    },
    limit: {
      type: 'number',
      description: '本次取回多少条（1–1000）。默认 100。',
    },
    page: {
      type: 'number',
      description: '第几页（从 1 开始）。默认 1。',
    },
    ...SHARED_PROPS,
  },
  required: [],
}

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '本次调用是否成功得到结果。' },
      status: { type: 'string', description: '结果状态：ok / needs_key / error。' },
      message: { type: 'string', description: '给模型看的可读总结（含表格与统计）。' },
      data: { type: 'string', description: '结构化结果（JSON 字符串）。' },
    },
    required: ['ok', 'status', 'message'],
  },
  render(_args, value) {
    const status = value && typeof value === 'object' ? value.status : undefined
    return [
      {
        type: 'text',
        text: String((value && typeof value === 'object' && value.message) || '(无输出)'),
      },
      ...(status === 'needs_key'
        ? [{ type: 'text', text: '需要补充 API key 后重试。' }]
        : []),
    ]
  },
}

function envOr(envName, fallback) {
  const value = process.env[envName]
  return value && String(value).trim() ? String(value).trim() : fallback
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeTag(text) {
  return String(text || 'query').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || 'query'
}

/**
 * 由命中材料生成建议的 WoS 检索式。
 * 只做"提示"，不产生插件间耦合 —— 编排仍由模型按 SEARCH-PROTOCOL.md 完成。
 */
function buildWosHint(records) {
  // 每个化学式给出**元素顺序排列**的多种写法 —— MP 会重排元素（ScRuP → ScPRu），
  // WoS 文献写法同样不统一，只查一种写法会漏文献（材料总纲 R8）。
  const seen = new Set()
  const entries = []
  for (const record of records) {
    if (entries.length >= 4) break
    const variants = formulaVariants(record)
    if (!variants.length) continue
    const key = variants[0]
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ label: record.formula_pretty || key, variants })
  }
  if (!entries.length) return ''

  const lines = [
    '',
    '**建议的 WoS 检索式**（复制到 wos_fetch 用；**已覆盖元素顺序排列**，文献写法不统一）：',
    '',
  ]
  for (const entry of entries) {
    const quoted = entry.variants.map((v) => `"${v}"`).join(' OR ')
    lines.push(`- ${entry.label}：TS = \`(${quoted}) AND superconduct*\``)
  }

  const sgs = [...new Set(records.map((r) => spaceGroupText(r)).filter((s) => s && s !== '（无）'))]
  if (sgs.length === 1) {
    const sym = sgs[0].split(' ')[0]
    lines.push(`- 按空间群反查：TS = \`"${sym}" AND superconduct*\``)
  }
  if (entries.length < records.length) {
    lines.push('', `（仅列出前 ${entries.length} 个化学式的检索式，其余见原始 JSON）`)
  }
  return lines.join('\n')
}

function buildSummaryStats(records) {
  const total = records.length
  if (!total) return []
  const byCrystal = new Map()
  const byElement = new Map()
  let stable = 0
  let metal = 0
  let experimental = 0
  const propsCount = Object.fromEntries(KEY_PROPS.map((k) => [k, 0]))

  for (const r of records) {
    const cs = r.symmetry?.crystal_system || '未知'
    byCrystal.set(cs, (byCrystal.get(cs) || 0) + 1)
    for (const el of r.elements || []) byElement.set(el, (byElement.get(el) || 0) + 1)
    if (r.is_stable) stable += 1
    if (r.is_metal) metal += 1
    if (r.theoretical === false) experimental += 1
    for (const k of KEY_PROPS) if (r.has_props?.[k]) propsCount[k] += 1
  }

  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}(${v})`)
      .join('、')

  return [
    '',
    '**统计**',
    '',
    `- 命中总数：${total}`,
    `- 晶系分布：${top(byCrystal, 6)}`,
    `- 元素分布（前 12）：${top(byElement, 12)}`,
    `- 热力学稳定：${stable} / ${total}`,
    `- 金属性：${metal} / ${total}`,
    `- 结构源自实验：${experimental} / ${total}`,
    `- 含关键属性：` +
      KEY_PROPS.map((k) => `${k}=${propsCount[k]}`).join('，'),
  ]
}

function describeError(error) {
  if (error instanceof MpError) {
    const needsKey = error.status === 401
    return {
      status: needsKey ? 'needs_key' : 'error',
      hint: error.hint || error.message,
    }
  }
  return { status: 'error', hint: String(error?.message || error) }
}

function reportApplyError(error) {
  const text =
    `[${new Date().toISOString()}] apply() 抛出异常\n` +
    `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}\n` +
    `${error?.stack ?? '(no stack)'}\n`
  try {
    process.stderr.write(`dsh-mp-fetch: apply() failed: ${error?.message ?? String(error)}\n`)
  } catch {
    /* stderr 不可用则忽略 */
  }
  try {
    const file = join(dataDir(), 'plugin-apply-error.log')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, { flag: 'a', encoding: 'utf8' })
  } catch {
    /* 诊断写入失败绝不影响主流程 */
  }
}

export function apply(ctx, config = {}) {
  try {
    return applyInner(ctx, config)
  } catch (error) {
    reportApplyError(error)
    throw error
  }
}

/**
 * ⚠️ 必须把 inject 也挂到 apply 函数对象上：cordis 的 Registry.plugin 读的是
 * plugin.inject，而 loader 对 ESM 做 unwrapExports 后会丢掉模块上的命名导出。
 * 只写 `export const inject` 会静默失效（已在 dsh-wos-fetch 上踩过）。
 */
apply.inject = inject

function applyInner(ctx, config = {}) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-mp-fetch：拿不到 ctx.tools，无法注册工具')
  }

  const state = {
    keyFileOverride: config.keyFile ?? envOr('MP_KEY_FILE', null),
    outputDirOverride: config.outputDir ?? envOr('MP_OUTPUT_DIR', null),
    timeoutMs: Number(config.timeoutMs ?? 60000),
  }

  /**
   * Resolve the API key for one call.
   *
   * Precedence: explicit `key_file` argument, then the DSH credential store,
   * then the legacy key file. The returned object never carries a path when
   * the value came from the credential store.
   */
  const loadKey = async (override) => {
    if (override) {
      const file = String(override)
      const read = readKeyFile(file)
      if (read.ok) {
        return { ok: true, apiKey: read.key, source: 'file', path: read.path, modifiedAt: read.modifiedAt }
      }
      try {
        ensureKeyFile(file)
      } catch (error) {
        logWarn(ctx, `dsh-mp-fetch: 无法创建 key 文件：${error.message}`)
      }
      return { ok: false, source: 'file', path: read.path, reason: read.reason }
    }

    const credential = await resolveCredential(ctx, FALLBACK_KEY_REFS)
    if (credential) {
      return {
        ok: true,
        apiKey: credential.value,
        source: 'credential',
        ref: credential.ref,
        origin: credential.source,
        path: null,
      }
    }

    const fallbackFile = state.keyFileOverride ?? defaultKeyFile()
    const read = readKeyFile(fallbackFile)
    if (read.ok) {
      return { ok: true, apiKey: read.key, source: 'file', path: read.path, modifiedAt: read.modifiedAt }
    }
    try {
      ensureKeyFile(fallbackFile)
    } catch (error) {
      logWarn(ctx, `dsh-mp-fetch: 无法创建 key 文件：${error.message}`)
    }
    return { ok: false, source: 'file', path: read.path, reason: read.reason }
  }

  const saveRaw = (tag, payload) => {
    try {
      const dir = state.outputDirOverride ?? outputDir()
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `mp-${safeTag(tag)}-${stamp()}-${Math.random().toString(36).slice(2, 6)}.json`)
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
      return file
    } catch (error) {
      logWarn(ctx, `dsh-mp-fetch: JSON 落盘失败：${error.message}`)
      return null
    }
  }

  const needsKeyResult = (info) => ({
    ok: false,
    status: 'needs_key',
    message: keyHelp({ path: info.path, reason: info.reason }),
    data: JSON.stringify({
      status: 'needs_key',
      keyFile: info.path ?? null,
      keySource: info.source,
      reason: info.reason,
    }),
  })

  /** 按 extras 列表补打端点。任何一项失败都只记录、不中断主查询。 */
  const enrich = async (records, extras, opts) => {
    const ids = records.map((r) => r.material_id).filter(Boolean)
    if (!ids.length || !extras.length) return { extras: {}, warnings: [] }
    const extrasData = {}
    const warnings = []
    for (const group of extras) {
      const ep = EXTRA_GROUPS[group]
      if (!ep) continue
      // 必须显式投影字段：不写 _fields 时 MP 只回 material_id，字段会全是空。
      const projection = EXTRA_FIELDS[group]
      const common = {
        id_format: 'legacy',
        ...(projection ? { _fields: projection } : {}),
      }
      try {
        let rows
        if (group === 'synthesis') {
          // synthesis 端点的 _fields 在 OpenAPI 里没有描述，传了会被拒；
          // 因此这里只传 id_format。
          const formulas = [...new Set(records.map((r) => r.formula_pretty).filter(Boolean))]
          rows = []
          for (const f of formulas) {
            const res = await request(EP.synthesis, { target_formula: f, _limit: 20 }, opts)
            rows.push(...res.data)
          }
        } else if (group === 'phonon') {
          // phonon 端点的标识符是 task_id 命名空间，不是 material_id；
          // 用 formula 反查更可靠。
          const formulas = [...new Set(records.map((r) => r.formula_pretty).filter(Boolean))]
          rows = []
          for (const f of formulas) {
            const res = await request(EP.phonon, { formula: f, _limit: 20, ...common }, opts)
            rows.push(...res.data)
          }
        } else {
          rows = await byMaterialIds(EP[ep], ids, common, opts)
        }
        extrasData[group] = rows
      } catch (error) {
        warnings.push(`${group}: ${error?.message || error}`)
      }
    }
    return { extras: extrasData, warnings }
  }

  const renderExtras = (extrasData) => {
    const out = []
    if (extrasData.debye?.length) {
      out.push('', '**德拜温度与弹性（elasticity 端点）**', '')
      for (const r of extrasData.debye) {
        const dv = r.debye_temperature
        const sv = r.sound_velocity
        const bm = r.bulk_modulus
        const gm = r.shear_modulus
        const label = `${r.formula_pretty || '?'} (${r.material_id})`
        if ((dv === null || dv === undefined) && !sv && !bm) {
          out.push(`- ${label}：**无弹性数据**（该材料未算过 elasticity）`)
          continue
        }
        out.push(
          `- ${label}：` +
            `德拜温度 ${dv === null || dv === undefined ? '—' : Number(dv).toFixed(1)} K；` +
            `声速 横${sv?.transverse ? Math.round(sv.transverse) : '—'} / ` +
            `纵${sv?.longitudinal ? Math.round(sv.longitudinal) : '—'} m/s；` +
            `B_VRH ${bm?.vrh ?? '—'} GPa；G_VRH ${gm?.vrh ?? '—'} GPa`,
        )
      }
    }
    if (extrasData.synthesis?.length) {
      out.push('', '**文献合成配方（synthesis 端点）**', '')
      for (const r of extrasData.synthesis.slice(0, 12)) {
        const cond = r.conditions || r.synthesis?.conditions || {}
        const bits = []
        if (cond.heating_temperature) bits.push(`温度 ${JSON.stringify(cond.heating_temperature)}`)
        if (cond.heating_time) bits.push(`时间 ${JSON.stringify(cond.heating_time)}`)
        if (cond.heating_atmosphere) bits.push(`气氛 ${JSON.stringify(cond.heating_atmosphere)}`)
        const precursors = (r.precursors || [])
          .map((p) => p?.material_formula || p?.formula)
          .filter(Boolean)
        out.push(
          `- ${r.target_formula || r.material_id || '?'}` +
            (precursors.length ? `：前驱体 ${precursors.join(' + ')}` : '') +
            (bits.length ? `；${bits.join('；')}` : ''),
        )
      }
    }
    if (extrasData.robocrys?.length) {
      out.push('', '**结构描述（robocrys 端点）**', '')
      for (const r of extrasData.robocrys.slice(0, 5)) {
        const text = r.description || r.robocrys?.description
        if (text) out.push(`- ${r.material_id}：${String(text).slice(0, 400)}`)
      }
    }
    if (extrasData.similarity?.length) {
      out.push('', '**结构相似材料（similarity 端点）**', '')
      for (const r of extrasData.similarity.slice(0, 5)) {
        // 注意：字段名是 `sim`（不是 similar_materials）
        const sim = r.sim ?? []
        const names = (Array.isArray(sim) ? sim : [sim])
          .map((s) => (s && typeof s === 'object' ? s.material_id : s))
          .filter(Boolean)
          .slice(0, 10)
        out.push(`- ${r.material_id}：${names.length ? names.join(', ') : '（无相似材料记录）'}`)
      }
    }
    if (extrasData.phonon?.length) {
      out.push('', '**声子数据（phonon 端点）**', '')
      out.push(
        '- ⚠️ MP 的 phonon 端点只给计算元信息与（有时有的）Born 有效电荷，' +
          '**不含频率、无法判定动力学稳定性**。有记录 ≠ 稳定相。' +
          '（schema 里虽声明了 `phonon_bandstructure` / `phonon_dos` / `force_constants`，' +
          '但实测这三个字段即使显式请求也一律返回 null。）',
      )
      for (const r of extrasData.phonon.slice(0, 8)) {
        out.push(
          `- ${r.formula_pretty || '?'} (${r.identifier || '?'})：method=${r.phonon_method || '—'}`,
        )
      }
    }
    if (extrasData.provenance?.length) {
      out.push('', '**来源（provenance 端点）**', '')
      for (const r of extrasData.provenance.slice(0, 8)) {
        const icsd = r.database_IDs?.icsd
        out.push(
          `- ${r.material_id}：` + (Array.isArray(icsd) && icsd.length ? icsd.join(', ') : '无 ICSD'),
        )
      }
    }
    return out.join('\n')
  }

  // ---------------------------------------------------------------- mp_lookup
  const lookupDefinition = {
    name: 'mp_lookup',
    description: [
      '查询 Materials Project：按化学式 / MP ID / 化学体系取回材料的空间群与物性。',
      '',
      '主要用途：',
      '- 给定化学式 → 拿到【空间群 + 晶系 + 点群 + ICSD 号】，用于按空间群归档；',
      '- 判断结构是否源自实验（theoretical=false ⇔ 有实验结构，可回溯 ICSD 文献）；',
      '- 一次看清同族材料：哪个稳定、哪个金属、哪个是磁性体系。',
      '',
      '注意：',
      '- MP **不含超导临界温度 Tc**，也不含电声耦合常数；Tc 必须靠 wos_fetch 查文献。',
      `- 默认 fields=core（空间群/稳定性/金属性/磁性/ICSD）。需要德拜温度、合成配方等请显式加字段组。`,
      '- 结果里的 wos_hint 给出建议的 WoS 检索式，便于接着用 wos_fetch 取证。',
      '',
      '限流（MP 官方写明 25 次/秒起；实测响应头）：25/秒 · 1000/分 · 40000/时 · 640000/天。',
      '工具会在结果末尾显示本秒/本小时余量；撞到 429 会按 RateLimit-Reset 退避重试（最多 2 次）。',
    ].join('\n'),
    parameters: LOOKUP_PARAMS,
    output: OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,

    presentCall(args) {
      const what = args?.formula || args?.material_ids || args?.chemsys || ''
      return { card: 'generic', title: `MP 查询 ${what}`, kind: 'fetch', rawInput: args }
    },

    presentResult(args, result) {
      const status = result && typeof result === 'object' ? result.status : undefined
      return {
        card: 'generic',
        title:
          status === 'ok'
            ? `MP 查询完成：${args?.formula || args?.chemsys || args?.material_ids || ''}`
            : status === 'needs_key'
              ? 'MP 查询需要补充 API key'
              : 'MP 查询失败',
        content: [{ type: 'text', text: String(result?.message ?? '') }],
      }
    },

    async execute(args, exec) {
      const formula = String(args?.formula ?? '').trim()
      const materialIds = String(args?.material_ids ?? '').trim()
      const chemsys = String(args?.chemsys ?? '').trim()

      const fail = (status, message, extra = {}) => ({
        ok: false,
        status,
        message,
        data: JSON.stringify({ status, ...extra }),
      })

      if (!formula && !materialIds && !chemsys) {
        return fail(
          'error',
          '至少要给一个条件：formula（化学式）、material_ids（MP ID）或 chemsys（化学体系）。\n' +
            '例如：formula="VFeAs"，或 chemsys="*-Ru-P"。',
        )
      }

      const keyInfo = await loadKey(args?.key_file)
      if (!keyInfo.ok) return needsKeyResult(keyInfo)

      const selection = resolveFieldSelection(args?.fields ?? 'core')
      if (selection.unknown.length) {
        return fail(
          'error',
          `不认识的字段组：${selection.unknown.join(', ')}。\n` +
            `可用：thermo / electronic / magnetism / elastic / surface / structure / props / all，` +
            `以及 debye / synthesis / robocrys / phonon / similarity / provenance / ` +
            `electronic_full / magnetism_full / thermo_full。`,
        )
      }

      const maxRows = Math.min(Math.max(Number(args?.max_rows ?? 30) || 30, 1), 200)
      const save = args?.save !== false
      const fullProps = args?.full_props === true

      // 拿掉 structure：它会撑爆上下文，默认只在显式要求时带
      const summaryFields = selection.summaryFields.filter(
        (f) => f !== 'structure' || selection.includeStructure,
      )

      const query = {
        _fields: summaryFields.join(','),
        id_format: 'legacy',
        _limit: 100,
      }
      if (formula) query.formula = formula
      if (materialIds) query.material_ids = materialIds
      if (chemsys) query.chemsys = chemsys
      if (args?.experimental_only === true) query.theoretical = false
      if (args?.stable_only === true) query.is_stable = true
      if (args?.metal_only === true) query.is_metal = true

      try {
        const res = await request(EP.summary, query, {
          apiKey: keyInfo.apiKey,
          timeoutMs: state.timeoutMs,
          signal: exec?.signal,
        })

        const records = res.data
        const { extras, warnings } = await enrich(records, selection.extras, {
          apiKey: keyInfo.apiKey,
          timeoutMs: state.timeoutMs,
          signal: exec?.signal,
        })

        const rawPath = save
          ? saveRaw(formula || materialIds || chemsys, {
              query,
              total: res.total,
              rateLimit: res.rateLimit,
              records,
              extras,
            })
          : null

        const head = [
          `Materials Project 查询：` +
            [
              formula && `formula="${formula}"`,
              materialIds && `material_ids="${materialIds}"`,
              chemsys && `chemsys="${chemsys}"`,
            ]
              .filter(Boolean)
              .join('，'),
          `命中 ${res.total} 条，返回 ${records.length} 条` +
            (selection.groups.length > 1 ? `，字段组 ${selection.groups.join('+')}` : ''),
        ]

        const parts = [...head, '', formatCensusTable(records, { maxRows, fullProps })]

        const details = records.slice(0, Math.min(records.length, Math.max(1, Math.min(maxRows, 8))))
        if (details.length) {
          for (const record of details) {
            parts.push(
              '',
              '---',
              '',
              formatDetail(record, {
                includeStructure: selection.includeStructure,
                fullProps,
              }),
            )
            const ncs = isNonCentrosymmetric(record)
            if (ncs === true) parts.push(`- 中心对称性：**非中心对称**（点群 ${record.symmetry?.point_group}）`)
            const notes = superconductorNotes(record)
            if (notes.length) parts.push(`- 超导相关性：${notes.join('；')}`)
          }
        }

        const extraBlock = renderExtras(extras)
        if (extraBlock) parts.push(extraBlock)

        parts.push(buildWosHint(records))

        if (warnings.length) parts.push('', `⚠️ 部分附加数据获取失败：${warnings.join('；')}`)
        if (rawPath) parts.push('', `原始 JSON：${rawPath}`)
        if (res.rateLimit?.remainingSecond !== null) {
          parts.push(`速率余量：本秒 ${res.rateLimit.remainingSecond}，本小时 ${res.rateLimit.remainingHour}`)
        }

        const data = {
          status: 'ok',
          query,
          total: res.total,
          recordCount: records.length,
          records,
          extras: Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, v.length])),
          rawPath,
          keyFile: keyInfo.path ?? null,
          keySource: keyInfo.source,
          keyRef: keyInfo.ref ?? null,
          apiVersion: res.apiVersion,
        }

        return {
          ok: true,
          status: 'ok',
          message: parts.filter((p) => p !== undefined).join('\n'),
          data: JSON.stringify(data),
        }
      } catch (error) {
        const { status, hint } = describeError(error)
        const message =
          status === 'needs_key'
            ? `${hint}\n\n${keyHelp({ path: keyInfo.path, reason: 'stale' })}`
            : `查询失败：${hint}`
        logWarn(ctx, `dsh-mp-fetch: ${hint}`)
        return fail(status, message, { error: String(error?.message || error) })
      }
    },
  }

  // ------------------------------------------------------------ mp_spacegroup
  const spacegroupDefinition = {
    name: 'mp_spacegroup',
    description: [
      '按空间群 / 晶系做 Materials Project 普查筛选 —— 对应 MP 网页端的空间群筛选，',
      '并额外支持网页端做不到的 chemsys 通配符（如 "*-Ru-P" 找所有含 Ru-P 的体系）。',
      '',
      '典型用法：',
      '- 找某个结构型的全部成员：spacegroup_number=189',
      '- 在某个空间群里找同体系材料：spacegroup_number=189 + chemsys="*-Ru-P"',
      '- 筛选超导候选：spacegroup_number=189 + metal_only=true + stable_only=true',
      '',
      '输出含普查表 + 统计摘要（晶系/元素分布、稳定与金属计数、关键属性可用性）。',
      '注意 MP 不含 Tc；这一步只做结构层面的候选筛选，超导证据仍需 wos_fetch。',
      '',
      '限流（MP 官方写明 25 次/秒起；实测响应头）：25/秒 · 1000/分 · 40000/时 · 640000/天。',
      '工具会显示余量并对 429 退避重试；不要用超大 limit 反复翻页。',
    ].join('\n'),
    parameters: SPACEGROUP_PARAMS,
    output: OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,

    presentCall(args) {
      const what =
        args?.spacegroup_number || args?.spacegroup_symbol || args?.crystal_system || ''
      return { card: 'generic', title: `MP 空间群普查 ${what}`, kind: 'fetch', rawInput: args }
    },

    presentResult(args, result) {
      const status = result && typeof result === 'object' ? result.status : undefined
      return {
        card: 'generic',
        title:
          status === 'ok'
            ? `MP 普查完成：${args?.spacegroup_number || args?.spacegroup_symbol || args?.crystal_system || ''}`
            : status === 'needs_key'
              ? 'MP 普查需要补充 API key'
              : 'MP 普查失败',
        content: [{ type: 'text', text: String(result?.message ?? '') }],
      }
    },

    async execute(args, exec) {
      const fail = (status, message, extra = {}) => ({
        ok: false,
        status,
        message,
        data: JSON.stringify({ status, ...extra }),
      })

      const sgNumber = args?.spacegroup_number
      const sgSymbol = String(args?.spacegroup_symbol ?? '').trim()
      const crystalSystem = String(args?.crystal_system ?? '').trim()
      const chemsys = String(args?.chemsys ?? '').trim()

      if (
        (sgNumber === undefined || sgNumber === null || String(sgNumber).trim() === '') &&
        !sgSymbol &&
        !crystalSystem
      ) {
        return fail(
          'error',
          '这个工具是"按空间群普查"，请至少给出 spacegroup_number、spacegroup_symbol ' +
            '或 crystal_system 之一。\n' +
            '如果只是想按化学式查单个材料，请改用 mp_lookup。',
        )
      }

      // 通配符只支持单一体系：多体系 + 通配是本插件已知的接口限制
      if (chemsys.includes('*') && chemsys.includes(',')) {
        return fail(
          'error',
          'chemsys 的通配符（*）只支持单个体系查询，不能和逗号列表一起用。\n' +
            '请逐个体系查询，或去掉通配符。',
        )
      }

      const keyInfo = await loadKey(args?.key_file)
      if (!keyInfo.ok) return needsKeyResult(keyInfo)

      const selection = resolveFieldSelection(args?.fields ?? 'core')
      if (selection.unknown.length) {
        return fail('error', `不认识的字段组：${selection.unknown.join(', ')}。`)
      }

      const limit = Math.min(Math.max(Number(args?.limit ?? 100) || 100, 1), 1000)
      const page = Math.max(Number(args?.page ?? 1) || 1, 1)
      const maxRows = Math.min(Math.max(Number(args?.max_rows ?? 30) || 30, 1), 200)
      const save = args?.save !== false
      const fullProps = args?.full_props === true

      const summaryFields = selection.summaryFields.filter(
        (f) => f !== 'structure' || selection.includeStructure,
      )

      const query = {
        _fields: summaryFields.join(','),
        id_format: 'legacy',
        _limit: limit,
        _skip: (page - 1) * limit,
      }
      if (sgNumber !== undefined && sgNumber !== null && String(sgNumber).trim() !== '') {
        query.spacegroup_number = String(sgNumber).trim()
      }
      if (sgSymbol) query.spacegroup_symbol = sgSymbol
      if (crystalSystem) query.crystal_system = crystalSystem
      if (chemsys) query.chemsys = chemsys
      if (args?.elements) query.elements = String(args.elements).trim()
      if (args?.exclude_elements) query.exclude_elements = String(args.exclude_elements).trim()
      if (args?.formula) query.formula = String(args.formula).trim()
      if (args?.nelements !== undefined && args?.nelements !== null) {
        query.nelements = Number(args.nelements)
      }
      if (args?.sort) query._sort_fields = String(args.sort).trim()
      if (args?.experimental_only === true) query.theoretical = false
      if (args?.stable_only === true) query.is_stable = true
      if (args?.metal_only === true) query.is_metal = true

      try {
        const res = await request(EP.summary, query, {
          apiKey: keyInfo.apiKey,
          timeoutMs: state.timeoutMs,
          signal: exec?.signal,
        })

        const records = res.data
        const rawPath = save
          ? saveRaw(
              `sg-${sgNumber || sgSymbol || crystalSystem}${chemsys ? '-' + chemsys : ''}-p${page}`,
              { query, total: res.total, rateLimit: res.rateLimit, records },
            )
          : null

        const filters = [
          query.spacegroup_number && `空间群号 ${query.spacegroup_number}`,
          query.spacegroup_symbol && `空间群符号 ${query.spacegroup_symbol}`,
          query.crystal_system && `晶系 ${query.crystal_system}`,
          query.chemsys && `体系 ${query.chemsys}`,
          query.elements && `含 ${query.elements}`,
          query.exclude_elements && `排除 ${query.exclude_elements}`,
          query.nelements !== undefined && `${query.nelements} 元`,
          query.is_metal === true && '仅金属',
          query.is_stable === true && '仅稳定相',
          query.theoretical === false && '仅实验结构',
        ].filter(Boolean)

        const parts = [
          `Materials Project 空间群普查：${filters.join('，') || '（无过滤条件）'}`,
          `命中 ${res.total} 条，本页返回 ${records.length} 条（第 ${page} 页，每页 ${limit} 条）` +
            (query._sort_fields ? `，排序 ${query._sort_fields}` : ''),
          '',
          formatCensusTable(records, { maxRows, fullProps }),
          buildSummaryStats(records).join('\n'),
        ]

        if (rawPath) parts.push('', `原始 JSON：${rawPath}`)

        const data = {
          status: 'ok',
          query,
          total: res.total,
          page,
          limit,
          recordCount: records.length,
          records,
          rawPath,
          keyFile: keyInfo.path ?? null,
          keySource: keyInfo.source,
          keyRef: keyInfo.ref ?? null,
          apiVersion: res.apiVersion,
        }

        return {
          ok: true,
          status: 'ok',
          message: parts.join('\n'),
          data: JSON.stringify(data),
        }
      } catch (error) {
        const { status, hint } = describeError(error)
        const message =
          status === 'needs_key'
            ? `${hint}\n\n${keyHelp({ path: keyInfo.path, reason: 'stale' })}`
            : `普查失败：${hint}`
        logWarn(ctx, `dsh-mp-fetch: ${hint}`)
        return fail(status, message, { error: String(error?.message || error) })
      }
    },
  }

  const habitsDefinition = {
    name: 'mp_habits',
    description:
      '读取、写入或重置本机 Materials Project 使用习惯。用户口述查询/归档偏好时用 write 保存成条目；不要只记在对话里。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'read=读取当前习惯；write=保存新习惯；reset=恢复出厂默认。',
          enum: ['read', 'write', 'reset'],
        },
        content: {
          type: 'string',
          description: `write 时必填。完整的习惯正文，建议用编号列表；上限 ${MAX_HABITS_CHARS} 字。`,
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string', description: '给模型看的可读结果。' },
          data: { type: 'string', description: '结构化结果（JSON 字符串）。' },
        },
        required: ['ok', 'message'],
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.message ?? '(无输出)') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,

    async execute(args) {
      const action = String(args?.action ?? 'read').toLowerCase()
      try {
        if (action === 'read') {
          const current = readHabits()
          return {
            ok: true,
            message: `当前 MP 使用习惯（${current.path}）：\n\n${current.content.trim()}`,
            data: JSON.stringify({ action, ...current }),
          }
        }
        if (action === 'write') {
          const next = writeHabits(args?.content)
          return {
            ok: true,
            message: `已保存 MP 使用习惯（${next.content.trim().length} 字）到：\n${next.path}\n\n下一条消息起生效。`,
            data: JSON.stringify({ action, ...next }),
          }
        }
        if (action === 'reset') {
          const next = resetHabits()
          return {
            ok: true,
            message: `已恢复出厂默认 MP 使用习惯。\n路径：${next.path}\n\n下一条消息起生效。`,
            data: JSON.stringify({ action, ...next }),
          }
        }
        return {
          ok: false,
          message: `不认识的 action "${action}"；可用 read / write / reset。`,
          data: JSON.stringify({ action, error: 'invalid-action' }),
        }
      } catch (error) {
        return {
          ok: false,
          message: `习惯操作失败：${error?.message || error}`,
          data: JSON.stringify({ action, error: String(error?.message || error) }),
        }
      }
    },
  }

  const disposers = [
    tools.register(lookupDefinition),
    tools.register(spacegroupDefinition),
    tools.register(habitsDefinition),
  ]

  /**
   * Web routes are optional: desktop Electron loads the client over file:// and
   * has no HTTP carrier. Use `ctx.inject` instead of `ctx.get` because the
   * webserver service may activate after this plugin; a one-shot `get` returns
   * undefined and the route silently never appears (observed as 404 on the
   * settings API).
   */
  try {
    const fiber = ctx.inject(['webServer'], (webCtx) => {
      try {
        const dispose = registerSettingsRoute(webCtx.webServer)
        if (typeof dispose === 'function') {
          logInfo(ctx, 'dsh-mp-fetch: 数据位置路由已注册')
          return dispose
        }
        logWarn(ctx, 'dsh-mp-fetch: webServer 不可用，跳过数据位置路由')
      } catch (error) {
        logWarn(ctx, `dsh-mp-fetch: 注册数据位置路由失败：${error.message}`)
      }
      return undefined
    })
    if (fiber && typeof fiber.dispose === 'function') disposers.push(() => fiber.dispose())
  } catch (error) {
    logWarn(ctx, `dsh-mp-fetch: 注册数据位置路由失败：${error.message}`)
  }
  logInfo(ctx, 'dsh-mp-fetch: 已注册工具 mp_lookup, mp_spacegroup, mp_habits')

  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const disposePrompt = systemPrompt.section({
        name: 'essayreader-mp-habits',
        order: 3006,
        text: () => {
          try {
            const current = readHabits()
            const body = current.content.trim()
            if (!body) return ''
            const clipped =
              body.length > 6000
                ? `${body.slice(0, 6000)}\n\n（习惯文档较长，此处截断；完整内容见 ${current.path}）`
                : body
            return [
              '## 课题组 MP 使用习惯（本机）',
              '',
              clipped,
              '',
              `习惯文档：${current.path}`,
              '当用户要求修改使用习惯时，调用 mp_habits(action="write", content="...") 保存；不要只记在对话里。',
            ].join('\n')
          } catch {
            return ''
          }
        },
      })
      if (typeof disposePrompt === 'function') disposers.push(disposePrompt)
    } catch (error) {
      logWarn(ctx, `dsh-mp-fetch: 注册系统提示失败：${error.message}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* 卸载失败不该抛 */
      }
    }
  }
}

export default apply
