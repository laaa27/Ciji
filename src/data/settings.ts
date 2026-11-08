import { Preferences } from '@capacitor/preferences'

/** 功能开关类设置的存取。键都在 CapacitorStorage 里，和其它数据同一处。 */

const PREDICTIVE_BACK_KEY = 'predictive_back_enabled'

/** 预测性返回手势开关（默认关：新交互交给用户选择）。同步读，供返回栈热路径用。 */
let predictiveBackEnabled = false

export function getPredictiveBackEnabled(): boolean {
  return predictiveBackEnabled
}

export function setPredictiveBackEnabled(enabled: boolean): void {
  predictiveBackEnabled = enabled
  void Preferences.set({ key: PREDICTIVE_BACK_KEY, value: enabled ? '1' : '0' })
}

/** 应用启动时读一次，把开关恢复到上次的状态 */
export async function loadSettings(): Promise<void> {
  const { value } = await Preferences.get({ key: PREDICTIVE_BACK_KEY })
  predictiveBackEnabled = value === '1'
}
