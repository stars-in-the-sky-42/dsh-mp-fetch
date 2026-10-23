/**
 * Materials Project REST 客户端 —— 纯 fetch，零第三方依赖。
 *
 * 为什么直连 REST 而不用官方的 mp-api（Python）：
 *   DSH 插件跑在 Node.js 里，调 REST 就够了；mp-api 依赖 pymatgen / pyarrow /
 *   deltalake 等一大串，在 Python 3.14 上还有 wheel 缺失风险。详见
 *   docs/PLAN-mp-plugin.md §3。
 *
 * 实测记录（docs/PLAN-mp-plugin.md §1）：
 *   - 鉴权：请求头 X-API-KEY
 *   - 速率限制：25/秒、1000/分、40000/时，响应头 X-RateLimit-Remaining-* 实时回报
 *   - 鉴权失败：HTTP 401（空 body）
 *   - id_format=legacy 可让接口回吐 mp-1095040 这种老 ID（默认是新的混淆 ID）
 */

export const BASE = 'https://api.materialsproject.org'

export const EP = {
  summary: '/materials/summary/',
  core: '/materials/core/',
  thermo: '/materials/thermo/',
  electronic: '/materials/electronic_structure/',
  magnetism: '/materials/magnetism/',
  elasticity: '/materials/elasticity/',
  synthesis: '/materials/synthesis/',
  robocrys: '/materials/robocrys/',
  similarity: '/materials/similarity/',
  phonon: '/materials/phonon/',
  provenance: '/materials/provenance/',
  formulaAutocomplete: '/materials/core/formula_autocomplete/',
}

export class MpError extends Error {
  constructor(message, { status = 0, hint = '' } = {}) {
    super(message)
    this.name = 'MpError'
    this.status = status
    this.hint = hint
  }
}

const DEFAULT_TIMEOUT_MS = 60000
const MAX_RETRIES = 2

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 数组用逗号连接（接口约定），undefined/null 直接跳过。 */
export function joinQuery(params) {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (!value.length) continue
      usp.set(key, value.join(','))
    } else if (typeof value === 'boolean') {
      usp.set(key, value ? 'true' : 'false')
    } else {
      usp.set(key, String(value))
    }
  }
  return usp
}

function readRateLimit(headers) {
  const pick = (name) => {
    const v = headers.get(name)
    return v === null ? null : Number(v)
  }
  return {
    limitPerSecond: pick('X-RateLimit-Limit-Second'),
    remainingSecond: pick('X-RateLimit-Remaining-Second'),
    remainingMinute: pick('X-RateLimit-Remaining-Minute'),
    remainingHour: pick('X-RateLimit-Remaining-Hour'),
    remainingDay: pick('X-RateLimit-Remaining-Day'),
  }
}

/**
 * 发一次请求。内置 429 退避重试、超时、外部取消。
 * 返回 { data, total, url, rateLimit, apiVersion }。
 */
export async function request(path, params = {}, opts = {}) {
  const {
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    maxRetries = MAX_RETRIES,
  } = opts

  if (!apiKey) {
    throw new MpError('缺少 Materials Project API key', {
      hint: '先在 key 文件里填入 key（用 key_file 参数可指定其它路径）。',
    })
  }

  const qs = joinQuery(params).toString()
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`

  let attempt = 0
  for (;;) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const onAbort = () => ac.abort()
    if (signal) {
      if (signal.aborted) ac.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    let resp
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
        signal: ac.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (signal?.aborted) throw new MpError('请求已取消')
      if (error?.name === 'AbortError') {
        throw new MpError(`请求超时（${timeoutMs} ms）`, { hint: '可调大 timeoutMs 或缩小 _limit。' })
      }
      if (attempt++ < maxRetries) {
        await sleep(600 * attempt)
        continue
      }
      throw new MpError(`网络请求失败：${error?.message || error}`, {
        hint: '检查网络/代理设置。',
      })
    }
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)

    // 撞速率限制：按响应头等待后重试
    if (resp.status === 429 && attempt++ < maxRetries) {
      const reset = Number(resp.headers.get('RateLimit-Reset') || 1)
      await sleep(Math.max(reset, 1) * 1000 + 250)
      continue
    }

    if (resp.status === 401) {
      throw new MpError('Materials Project 鉴权失败（HTTP 401）', {
        status: 401,
        hint: 'API key 无效、已重置或复制不完整。请到 Dashboard 重新复制并覆盖 key 文件。',
      })
    }

    if (!resp.ok) {
      let body = ''
      try {
        body = await resp.text()
      } catch {
        /* body 读不到就算了 */
      }
      const detail = body ? `：${body.replace(/\s+/g, ' ').slice(0, 300)}` : ''
      throw new MpError(`接口返回 HTTP ${resp.status}${detail}`, { status: resp.status })
    }

    const json = await resp.json()
    return {
      data: Array.isArray(json?.data) ? json.data : [],
      total: json?.meta?.total_doc ?? 0,
      apiVersion: json?.meta?.api_version ?? null,
      maxLimit: json?.meta?.max_limit ?? null,
      url,
      rateLimit: readRateLimit(resp.headers),
    }
  }
}

/** 把 material_ids 列表按接口上限切块，避免一次塞太多。 */
export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 在某个端点上按一批 material_ids 取数据。
 * 用来给 summary 命中的材料"补"其它端点的属性（弹性、磁性、合成…）。
 * 单个 id 查不到不报错，只是不在结果里。
 */
export async function byMaterialIds(path, materialIds, params = {}, opts = {}) {
  const ids = Array.isArray(materialIds) ? materialIds.filter(Boolean) : []
  if (!ids.length) return []
  const out = []
  for (const group of chunk(ids, 100)) {
    const res = await request(path, { material_ids: group, ...params }, opts)
    out.push(...res.data)
  }
  return out
}

/** 化学式自动补全（用来校验用户给的化学式是否存在）。 */
export async function formulaAutocomplete(formula, opts = {}) {
  try {
    const res = await request(EP.formulaAutocomplete, { formula, limit: 20 }, { ...opts, maxRetries: 0 })
    return res.data
  } catch {
    // 补全只是锦上添花，失败不该让主查询挂掉
    return []
  }
}
