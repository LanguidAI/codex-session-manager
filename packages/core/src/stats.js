import { listSessions } from './catalog.js'

/** 汇总统计（纯只读）：总数/归档数/近7天 + 按天/项目/模型/供应商分布。 */
export async function buildStats({ home }) {
  const all = await listSessions({ home, includeArchived: true })
  const active = all.filter((s) => !s.archived)
  const byDay = {}
  const byProject = {}
  const byModel = {}
  const byProvider = {}
  const bump = (obj, key) => {
    if (key) obj[key] = (obj[key] ?? 0) + 1
  }
  for (const s of active) {
    bump(byDay, (s.updatedAt ?? '').slice(0, 10))
    bump(byProject, s.cwd)
    bump(byModel, s.model)
    bump(byProvider, s.provider)
  }
  const weekAgoMs = Date.now() - 7 * 86_400_000
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
