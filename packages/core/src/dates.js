/**
 * 严格的时间戳判别（I-2 纵深防御）。
 *
 * 为什么不用裸 `Date.parse`：它对非 ISO 形状（`2026/01/01`、`Jan 1 2026`）会宽松解析，
 * 而各引擎的宽松程度并不一致（Safari/Firefox/V8 各有差异）→ 同一份索引在不同浏览器
 * 会得出不同的 updatedAt，排序与「近 7 天」统计随之漂移。这里做「ISO 形状正则 + 解析」
 * 双重校验：形状先筛掉宽松格式，解析再筛掉 `2026-13-45` 这类形状合法但日期非法的值。
 */

/** ISO 8601 日期时间（含可选小数秒与时区），与 Codex 索引/rollout 的写法一致。 */
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/

/**
 * 是否为严格 ISO 8601 时间戳字符串。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isIsoTimestamp(v) {
  if (typeof v !== 'string' || !ISO_SHAPE.test(v)) return false
  return Number.isFinite(Date.parse(v))
}

/**
 * 把值解析成毫秒时间戳；非严格 ISO（含数字、null、宽松格式）一律返回 NaN。
 * 调用方据此回落（如改用文件 mtime），避免宽松解析污染排序。
 * @param {unknown} v
 * @returns {number} 毫秒时间戳，或 NaN
 */
export function parseIsoMs(v) {
  return isIsoTimestamp(v) ? Date.parse(v) : NaN
}