/**
 * MP 字段组定义 + 中文标签 + markdown 渲染。
 *
 * 设计目标（对齐用户"便于归档"的要求）：
 *   - 把 MP 的英文驼峰字段翻译成中文标签，结果可以直接抄进 materials/ 文档；
 *   - 空间群一律渲染成 `P-62m (#189)` 形式，符合工作区的"必须写清空间群"规范；
 *   - 表格只放"扫一眼能筛掉一批"的列，细节放详情块，避免刷屏。
 */

/** summary 端点上的字段组。core 永远会被请求。 */
export const SUMMARY_GROUPS = {
  thermo: [
    'formation_energy_per_atom',
    'energy_per_atom',
    'uncorrected_energy_per_atom',
    'equilibrium_reaction_energy_per_atom',
    'decomposes_to',
  ],
  electronic: ['cbm', 'vbm', 'efermi', 'is_gap_direct', 'dos'],
  magnetism: [
    'total_magnetization_normalized_vol',
    'total_magnetization_normalized_formula_units',
    'num_magnetic_sites',
    'num_unique_magnetic_sites',
    'types_of_magnetic_species',
  ],
  elastic: ['bulk_modulus', 'shear_modulus', 'universal_anisotropy', 'homogeneous_poisson'],
  props: ['has_props'],
  structure: ['structure'],
  surface: [
    'weighted_surface_energy_EV_PER_ANG2',
    'weighted_surface_energy',
    'weighted_work_function',
    'surface_anisotropy',
    'shape_factor',
  ],
}

/** core 组：任何查询都会带上，是"归档必需"的最小集合。 */
export const CORE_FIELDS = [
  'material_id',
  'formula_pretty',
  'formula_anonymous',
  'chemsys',
  'elements',
  'nelements',
  'symmetry',
  'theoretical',
  'database_IDs',
  'is_stable',
  'energy_above_hull',
  'is_metal',
  'band_gap',
  'is_magnetic',
  'ordering',
  'total_magnetization',
  'nsites',
  'volume',
  'density',
  // 用于生成"元素顺序排列"的公式写法（WoS 检索须覆盖排列，见材料总纲 R8）
  'composition_reduced',
  'deprecated',
  'last_updated',
]

/**
 * 需要"再打一次别的端点"才能拿到的字段组。
 * 值是端点 key（见 mp.js 的 EP）。
 */
export const EXTRA_GROUPS = {
  debye: 'elasticity',
  synthesis: 'synthesis',
  robocrys: 'robocrys',
  phonon: 'phonon',
  similarity: 'similarity',
  provenance: 'provenance',
  electronic_full: 'electronic_structure',
  magnetism_full: 'magnetism',
  thermo_full: 'thermo',
}

/**
 * 各附加端点的字段投影。
 *
 * ⚠️ 必须显式列出字段：不写 `_fields` 时 MP 只返回 `material_id`
 * （返回体的 `meta.default_fields` 就是 `["material_id"]`），
 * 结果是"请求成功但字段全空"。实测踩过：elasticity 不写 _fields 时
 * debye_temperature 全是 null。
 *
 * synthesis 端点不在其列 —— 该端点的 `_fields` 参数在 OpenAPI 里没有描述，
 * 传了会报 "Request contains query parameters which cannot be used"。
 */
export const EXTRA_FIELDS = {
  debye:
    'material_id,formula_pretty,nsites,volume,density,debye_temperature,sound_velocity,' +
    'bulk_modulus,shear_modulus,young_modulus,thermal_conductivity,' +
    'universal_anisotropy,homogeneous_poisson',
  provenance: 'material_id,formula_pretty,database_IDs,theoretical,references,authors',
  electronic_full:
    'material_id,formula_pretty,band_gap,cbm,vbm,efermi,is_gap_direct,is_metal,magnetic_ordering',
  magnetism_full:
    'material_id,formula_pretty,ordering,is_magnetic,total_magnetization,num_magnetic_sites,' +
    'num_unique_magnetic_sites,types_of_magnetic_species',
  thermo_full:
    'material_id,formula_pretty,formation_energy_per_atom,energy_above_hull,is_stable,' +
    'decomposes_to,equilibrium_reaction_energy_per_atom,thermo_type',
  robocrys: 'material_id,formula_pretty,description,condensed_structure',
  // 注意字段名是 `sim`（不是 similar_materials）
  similarity: 'material_id,formula_pretty,sim,method',
  phonon: 'identifier,formula_pretty,phonon_method,epsilon_static,born,last_updated',
}

export const EXTRA_LABELS = {
  debye: '德拜温度/声速/模量（elasticity 端点）',
  synthesis: '文献合成配方（synthesis 端点）',
  robocrys: '结构的人话描述（robocrys 端点）',
  phonon: '声子计算元信息（phonon 端点）',
  similarity: '结构相似材料（similarity 端点）',
  provenance: '来源/ICSD 交叉引用（provenance 端点）',
  electronic_full: '完整电子结构（electronic_structure 端点）',
  magnetism_full: '完整磁性（magnetism 端点）',
  thermo_full: '完整热力学（thermo 端点）',
}

/**
 * 解析 fields 参数。
 * 支持 "core" | "all" | "core+thermo+debye" | "thermo,debye" 等写法。
 */
export function resolveFieldSelection(spec) {
  const raw = String(spec ?? 'core').trim()
  const parts = raw
    .split(/[+,]/)
    .map((s) => s.trim())
    .filter(Boolean)

  const wantAll = parts.includes('all') || raw === '*'
  const groups = wantAll
    ? [...Object.keys(SUMMARY_GROUPS), ...Object.keys(EXTRA_GROUPS)]
    : parts

  const summaryExtra = []
  const extras = []
  const unknown = []

  for (const g of groups) {
    if (g === 'core' || g === 'summary') continue
    if (Object.prototype.hasOwnProperty.call(SUMMARY_GROUPS, g)) {
      summaryExtra.push(...SUMMARY_GROUPS[g])
    } else if (Object.prototype.hasOwnProperty.call(EXTRA_GROUPS, g)) {
      extras.push(g)
    } else if (g !== 'all') {
      unknown.push(g)
    }
  }

  // props 默认带上：它回答"这个材料到底有什么数据"，成本极低
  if (!wantAll && !groups.includes('props')) summaryExtra.push(...SUMMARY_GROUPS.props)

  return {
    groups: ['core', ...groups.filter((g) => g !== 'core')],
    summaryFields: dedupe([...CORE_FIELDS, ...summaryExtra]),
    extras: dedupe(extras),
    includeStructure: groups.includes('structure') || wantAll,
    unknown: dedupe(unknown),
  }
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))]
}

export const LABELS = {
  material_id: 'MP ID',
  formula_pretty: '化学式',
  formula_anonymous: '匿名化学式',
  chemsys: '化学体系',
  elements: '元素',
  nelements: '元素数',
  symmetry: '空间群',
  theoretical: '来源',
  database_IDs: '数据库引用',
  is_stable: '热力学稳定',
  energy_above_hull: '凸包以上能量 (eV/atom)',
  formation_energy_per_atom: '形成能 (eV/atom)',
  energy_per_atom: '总能 (eV/atom)',
  uncorrected_energy_per_atom: '未校正总能 (eV/atom)',
  equilibrium_reaction_energy_per_atom: '平衡反应能 (eV/atom)',
  decomposes_to: '分解产物',
  is_metal: '金属性',
  band_gap: '带隙 (eV)',
  cbm: '导带底 (eV)',
  vbm: '价带顶 (eV)',
  efermi: '费米能 (eV)',
  is_gap_direct: '直接带隙',
  dos: '态密度',
  is_magnetic: '磁性',
  ordering: '磁有序',
  total_magnetization: '总磁矩 (μB)',
  total_magnetization_normalized_vol: '磁矩/体积',
  total_magnetization_normalized_formula_units: '磁矩/化学式单位',
  num_magnetic_sites: '磁性位点数',
  num_unique_magnetic_sites: '不等价磁性位点',
  types_of_magnetic_species: '磁性元素',
  nsites: '晶胞原子数',
  volume: '晶胞体积 (Å³)',
  density: '密度 (g/cm³)',
  density_atomic: '原子密度',
  deprecated: '已废弃',
  last_updated: '数据更新时间',
  bulk_modulus: '体模量 (GPa)',
  shear_modulus: '剪切模量 (GPa)',
  universal_anisotropy: '弹性各向异性',
  homogeneous_poisson: '泊松比',
  weighted_surface_energy_EV_PER_ANG2: '表面能 (eV/Å²)',
  weighted_surface_energy: '表面能',
  weighted_work_function: '功函数 (eV)',
  surface_anisotropy: '表面各向异性',
  shape_factor: '形状因子',
  has_props: '可用属性',
  structure: '结构',
  debye_temperature: '德拜温度 (K)',
  sound_velocity: '声速 (m/s)',
  young_modulus: '杨氏模量 (GPa)',
  thermal_conductivity: '热导率 (W/m/K)',
  elastic_tensor: '弹性张量',
  task_ids: '任务 ID',
  possible_species: '可能物种',
}

/** MP 文档里 20 个 has_props 位的中文名；超导相关四项打 ★。 */
export const HAS_PROPS_LABELS = {
  materials: '基础',
  thermo: '热力学',
  xas: 'XAS',
  grain_boundaries: '晶界',
  electronic_structure: '电子结构',
  bandstructure: '能带',
  dos: '★态密度',
  magnetism: '★磁性',
  elasticity: '★弹性',
  dielectric: '介电',
  piezoelectric: '压电',
  surface_properties: '表面',
  oxi_states: '氧化态',
  provenance: '来源',
  charge_density: '电荷密度',
  eos: '状态方程',
  phonon: '★声子',
  absorption: '吸收',
  insertion_electrodes: '嵌入电极',
  substrates: '衬底',
  chemenv: '配位环境',
}

/** 超导研究最关心的四个属性位（用户确认：默认只显示这四项）。 */
export const KEY_PROPS = ['phonon', 'elasticity', 'dos', 'magnetism']

export function spaceGroupText(record) {
  const s = record?.symmetry
  if (!s || !s.number) return '（无）'
  return `${s.symbol} (#${s.number})`
}

export function evidenceText(record) {
  if (record?.theoretical === false) return '实验'
  if (record?.theoretical === true) return '理论'
  return '未知'
}

export function icsdText(record) {
  const ids = record?.database_IDs?.icsd
  return Array.isArray(ids) && ids.length ? ids.join(', ') : ''
}

/** 精简属性视图：只列超导相关的四个位。 */
export function keyPropsText(record) {
  const props = record?.has_props
  if (!props || typeof props !== 'object') return ''
  const on = KEY_PROPS.filter((k) => props[k])
  return on.length ? on.join('/') : '无'
}

/** 完整属性视图（has_props 全 20 项）。 */
export function allPropsText(record) {
  const props = record?.has_props
  if (!props || typeof props !== 'object') return ''
  return Object.keys(props)
    .filter((k) => props[k])
    .map((k) => HAS_PROPS_LABELS[k] || k)
    .join('、')
}

function cell(value) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value)
  return text.replace(/\|/g, '\\|')
}

function num(value, digits = 4) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n === 0) return '0'
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

/** 普查表：一行一个材料，列是"扫一眼能筛掉一批"的那几个。 */
export function formatCensusTable(records, { maxRows = 30, fullProps = false } = {}) {
  if (!records.length) return '（没有命中记录）'
  const shown = records.slice(0, maxRows)
  const lines = [
    '| # | MP ID | 化学式 | 空间群 | 晶系 | e_hull | 稳定 | 金属 | 磁有序 | 来源 | ICSD | 关键属性 |',
    '|---|-------|--------|--------|------|--------|------|------|--------|------|------|----------|',
  ]
  shown.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${cell(r.material_id)} | ${cell(r.formula_pretty)} | ` +
        `${cell(spaceGroupText(r))} | ${cell(r.symmetry?.crystal_system)} | ` +
        `${cell(num(r.energy_above_hull))} | ${cell(r.is_stable ? '是' : '否')} | ` +
        `${cell(r.is_metal ? '是' : '否')} | ${cell(r.ordering)} | ${cell(evidenceText(r))} | ` +
        `${cell(icsdText(r) || '—')} | ${cell(fullProps ? allPropsText(r) : keyPropsText(r))} |`,
    )
  })
  if (records.length > shown.length) {
    lines.push('', `（表中仅显示前 ${shown.length} 条，共 ${records.length} 条）`)
  }
  return lines.join('\n')
}

function renderValue(key, value) {
  if (value === undefined || value === null || value === '') return null
  if (key === 'has_props' && typeof value === 'object') {
    return allPropsText({ has_props: value }) || '无'
  }
  if (key === 'symmetry' && typeof value === 'object') return spaceGroupText({ symmetry: value })
  if (key === 'database_IDs' && typeof value === 'object') {
    const parts = Object.entries(value)
      .filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `${k}: ${v.join(', ')}`)
    return parts.length ? parts.join('；') : null
  }
  if (key === 'structure') {
    const L = value?.lattice
    if (!L) return null
    return (
      `a=${num(L.a)} b=${num(L.b)} c=${num(L.c)} Å；` +
      `α=${num(L.alpha)} β=${num(L.beta)} γ=${num(L.gamma)}°；V=${num(L.volume)} Å³；` +
      `原子数=${Array.isArray(value.sites) ? value.sites.length : '?'}`
    )
  }
  // 数组必须在对象之前判断 —— 数组也是 object，否则会被 JSON.stringify 成 ["P","Ru","Sc"]
  if (Array.isArray(value)) return value.join(', ')
  if (key === 'theoretical') {
    // theoretical 是布尔，直接渲染成"是/否"会得到看不懂的"来源：否"
    return value === false ? '实验（结构源自实验数据库）' : '理论（计算预测结构）'
  }
  if (typeof value === 'object') {
    if ('vrh' in value) return `${num(value.vrh)} (Voigt ${num(value.voigt)} / Reuss ${num(value.reuss)})`
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return String(value)
  return String(value)
}

/**
 * 单条记录的详情块，只列有值的字段。
 * has_props 独立成一行：默认只显示超导相关的四项，`fullProps` 时才展开全部 20 项。
 */
export function formatDetail(record, { includeStructure = false, fullProps = false } = {}) {
  const lines = []
  const head = `${record.formula_pretty || '?'} — ${record.material_id || '?'}`
  lines.push(`**${head}**`)
  lines.push('')
  for (const [key, label] of Object.entries(LABELS)) {
    if (key === 'structure' && !includeStructure) continue
    if (key === 'has_props') continue // 见下方单独处理
    const rendered = renderValue(key, record[key])
    if (rendered === null) continue
    lines.push(`- ${label}：${rendered}`)
  }
  const propsLine = fullProps
    ? allPropsText(record)
    : KEY_PROPS.filter((k) => record?.has_props?.[k])
        .map((k) => HAS_PROPS_LABELS[k] || k)
        .join('、')
  if (propsLine) {
    lines.push(
      `- 可用属性：${propsLine}` +
        (fullProps ? '' : '（★项为超导相关；用 full_props=true 展开全部 20 项）'),
    )
  }
  return lines.join('\n')
}

/**
 * 超导相关性提示。把"这个材料值不值得往下看"的判断依据摆出来，
 * 而不是替用户下结论。
 */
export function superconductorNotes(record) {
  const notes = []
  const props = record?.has_props || {}
  if (record?.is_metal === true) notes.push('金属性 ✅（超导前提）')
  else if (record?.is_metal === false) notes.push('非金属 ❌（band_gap > 0）')
  if (record?.is_stable === true) notes.push('热力学稳定 ✅')
  else if (record?.energy_above_hull !== undefined && record?.energy_above_hull !== null) {
    notes.push(`凸包以上 ${num(record.energy_above_hull)} eV/atom（亚稳）`)
  }
  if (record?.theoretical === false) notes.push('结构源自实验 ✅（有 ICSD 可回溯）')
  else if (record?.theoretical === true) notes.push('结构为理论预测（无实验结构）')
  if (record?.symmetry?.point_group && !String(record.symmetry.point_group).includes('m')
      && !/[2-4]\/m/.test(String(record.symmetry.point_group))) {
    // 粗判：点群不含镜面/反演特征时提示非中心对称
  }
  if (props.phonon) notes.push('有声子计算数据（注意：MP 不给频率，无法判定动力学稳定性）')
  if (props.dos) notes.push('有态密度（N(E_F) 与电声耦合相关）')
  if (props.elasticity) notes.push('有弹性数据（可取德拜温度）')
  if (record?.is_magnetic === true) notes.push(`磁性体系（${record.ordering || '?'}）——与超导常相互竞争`)
  return notes
}

/** 非中心对称是 Fe2P 型家族的重要特征，单独标出来。 */
export function isNonCentrosymmetric(record) {
  const pg = String(record?.symmetry?.point_group || '')
  if (!pg) return null
  // 含反演中心的点群（中心对称）白名单
  const centrosymmetric = new Set([
    '-1', '2/m', 'mmm', '4/m', '4/mmm', '-3', '-3m', '6/m', '6/mmm', 'm-3', 'm-3m',
  ])
  return !centrosymmetric.has(pg)
}

/**
 * 生成同一组成的多种**元素顺序**写法。
 *
 * 为什么需要（材料总纲 R8）：MP 会重排元素（`ScRuP` → `ScPRu`），
 * 而 WoS 文献里的写法同样不统一。检索时必须覆盖排列组合，
 * **哪怕对 111 型也是如此**，否则会漏掉大量文献。
 *
 * 用 MP 的 `elements` + `composition_reduced` 构造，而不是解析 `formula_pretty`
 * （后者已被重排，解析反而更不可靠）。
 *
 * @returns {string[]} 形如 ['ScRuP','ScPRu','RuScP',...]；元素数 >4 或不适用时退化为单元素数组
 */
export function formulaVariants(record, limit = 6) {
  const elements = Array.isArray(record?.elements) ? record.elements.slice() : []
  const comp = record?.composition_reduced || {}
  const pretty = record?.formula_pretty

  if (elements.length < 2 || elements.length > 4) {
    return pretty ? [pretty] : []
  }

  const orders = []
  const walk = (rest, acc) => {
    if (orders.length >= limit) return
    if (!rest.length) {
      orders.push(acc.slice())
      return
    }
    for (let i = 0; i < rest.length && orders.length < limit; i += 1) {
      walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]])
    }
  }
  walk(elements, [])

  const render = (order) =>
    order
      .map((el) => {
        const n = comp[el]
        if (n === undefined || n === null) return el
        const num = Number(n)
        if (!Number.isFinite(num) || num === 1) return el
        return `${el}${num}`
      })
      .join('')

  const variants = [...new Set(orders.map(render).filter(Boolean))]

  // 把 MP 自己的写法放最前，方便对照
  if (pretty) {
    const idx = variants.indexOf(pretty)
    if (idx > 0) {
      variants.splice(idx, 1)
      variants.unshift(pretty)
    } else if (idx < 0) {
      variants.unshift(pretty)
    }
  }
  return variants.slice(0, limit)
}
