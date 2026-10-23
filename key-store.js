/**
 * Materials Project API key 的读写与"指路"逻辑。
 *
 * 设计取舍（与 dsh-wos-fetch 的 cookie-store 一致）：
 *   key 只从文件读，不硬编码进源码、不写进 cordis.patch.yml。
 *   文件缺失时自动建出带填写说明的模板，方便日后忘记时一眼看到该放哪。
 *
 * 兼容两种文件格式：
 *   1. 纯 key（一行 32 位字母数字）—— 当前工作区用的就是这种；
 *   2. 带 `#` 注释说明的模板 + 末尾真正的 key。
 * 解析时忽略注释行与空行，取第一个有意义的 token。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { dataDir } from './settings-store.js'

/** 本插件认为"最合理"的默认位置；实际值由插件 config 覆盖。 */
export function defaultKeyFile() {
  return join(dataDir(), 'api_key.txt')
}

export const KEY_TEMPLATE = `# ============================================================
#  Materials Project API Key —— dsh-mp-fetch 插件读取此文件
# ============================================================
#
#  首选做法：打开“设置 → 材料数据（MP）”，把 API key 粘进“凭据”一栏保存。
#  那个值存在 DSH 凭据库里，优先于本文件。
#
#  只有不想用设置页时，才把 key 填进本文件。
#
#  怎么填：
#    1. 登录 https://next-gen.materialsproject.org/dashboard
#    2. 在 Dashboard 页复制 API Key（32 位字母数字）
#    3. 粘贴到本文件最后一行（即下一行的位置），保存
#
#  注意：
#    - 只填 key 本身，不要带引号、不要带 "X-API-KEY:" 前缀。
#    - 这个文件等同于密码，不要提交到 git、不要发给别人、不要贴进对话。
#    - key 泄露后请到 Dashboard 重置，然后覆盖本文件。
#
#  当前 key 文件路径见文件末尾。
# ------------------------------------------------------------

`

/** 确保读到的是"真正的 key"，而不是模板里的说明文字。 */
export function parseKeyText(text) {
  const meaningful = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (!meaningful.length) return null
  // 取第一行里第一个空白分隔的 token，容忍误粘贴的前后缀
  const token = meaningful[0].split(/\s+/)[0]
  return token || null
}

export function isTemplateOnly(text) {
  return parseKeyText(text) === null
}

export function ensureKeyFile(path) {
  const file = resolve(path)
  const existed = existsSync(file)
  if (!existed) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${KEY_TEMPLATE}# key 文件位置：${file}\n`, 'utf8')
  }
  return { path: file, created: !existed }
}

export function writeKey(path, apiKey) {
  const file = resolve(path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${KEY_TEMPLATE}${String(apiKey).trim()}\n`, 'utf8')
  return file
}

export function readKeyFile(path) {
  const file = resolve(path)
  if (!existsSync(file)) {
    return { ok: false, path: file, reason: 'missing' }
  }
  const text = readFileSync(file, 'utf8')
  const key = parseKeyText(text)
  if (!key) {
    return { ok: false, path: file, reason: 'empty' }
  }
  return {
    ok: true,
    path: file,
    key,
    // 只回长度，绝不把 key 本身写进日志或工具输出
    keyLength: key.length,
    size: statSync(file).size,
    modifiedAt: statSync(file).mtime.toISOString(),
  }
}

/** key 缺失时的指引文本，直接给路径和步骤，避免只说一句"没配 key"。 */
export function keyHelp({ path, reason } = {}) {
  const why =
    reason === 'stale'
      ? 'API key 已失效或复制不完整'
      : reason === 'missing'
        ? '还没有配置 Materials Project API key'
        : '凭据里还没有填入真正的 API key'
  const lines = [
    `【需要先准备 Materials Project API key】${why}`,
    ``,
    `首选：打开 DSH 的“设置 → 材料数据（MP）”，在“凭据”里粘贴 API key 并保存。`,
    `  1. 登录 https://next-gen.materialsproject.org/dashboard`,
    `  2. 复制 API Key（32 位字母数字）`,
    `  3. 粘进设置页的输入框（只填 key 本身，不要引号、不要 X-API-KEY: 前缀）`,
    ``,
    `提示：key 等同于密码，请勿贴进对话或提交到版本库。`,
  ]
  if (path) {
    lines.push(
      '',
      `备用：也可以把 key 粘进这个文件的最后一行：`,
      `  ${resolve(path)}`,
    )
  }
  return lines.join('\n')
}
