/**
 * 复制到剪贴板。
 *
 * 为什么不用 @capacitor/clipboard：为了一个复制按钮多装一个原生插件不划算。
 * WebView 里 navigator.clipboard 在 https://localhost 这种安全上下文下可用，
 * 但个别系统 WebView 版本会因为"没有用户手势"或聚焦问题失败，所以保留
 * execCommand 兜底——两条路都失败时返回 false，让调用方如实提示。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }

  try {
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.top = '0'
    box.style.left = '0'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    box.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(box)
    return ok
  } catch {
    return false
  }
}
