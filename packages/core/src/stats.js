import { listSessions } from './catalog.js'

const MS_PER_DAY = 86_400_000

/**
 * 汇总统计（纯只读）：一律基于 ACTIVE 会话（archived 单列）。
 * @returns {Promise<{
 *   total: number,                      // 活跃会话数（不含 archived；总数 = total + archived）
 *   archived: number,                   // 归档会话数
 *   recent7: number,                    // 近 7 天内更新的活跃会话（数值时间戳比较）
 *   byDay: Record<string, number>,      // 键 = updatedAt 的 UTC 日期 YYYY-MM-DD；插入序 = listSessions 序（updatedAt 倒序，即最近在前）
 *   byProject: Record<string, number>,  // 键 = cwd
 *   byModel: Record<string, number>,    // 键 = model slug
 *   byProvider: Record<string, number>  // 键 = provider
 * }>}
 * 契约：falsy 的 cwd/model/provider 键被跳过，故对应 by* 之和可能 < total（如少量 model=null 的会话）。
 * by* 用 null 原型对象，杜绝 constructor/__proto__ 之类对抗键污染计数（审查 Issue 2）。
 */
export async function buildStats({ home }) {
  const all = await listSessions({ home, includeArchived: true })
  const active = all.filter((s) => !s.archived)
  const byDay = Object.create(null)
  const byProject = Object.create(null)
  const byModel = Object.create(null)
  const byProvider = Object.create(null)
  const bump = (obj, key) => {
    if (key) obj[key] = (obj[key] ?? 0) + 1
  }
  for (const s of active) {
    bump(byDay, (s.updatedAt ?? '').slice(0, 10))
    bump(byProject, s.cwd)
    bump(byModel, s.model)
    bump(byProvider, s.provider)
  }
  const weekAgoMs = Date.now() - 7 * MS_PER_DAY
  return {
    total: active.length,
    archived: all.length - active.length,
    // recent7 用数值时间戳比较（沿用 Task 4 I2 教训：ISO 混合小数精度下字符串比较会在边界误判）
    recent7: active.filter((s) => Date.parse(s.updatedAt ?? '') >= weekAgoMs).length,
    byDay,
    byProject,
    byModel,
    byProvider,
  }
}
