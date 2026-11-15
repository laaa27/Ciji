import styles from './BackButton.module.css'

type Props = {
  onClick: () => void
}

/**
 * 全 app 统一的返回键：一个左箭头，不带文字。
 *
 * 原先六处各写一遍「‹ 返回」或「返回」，字号与内边距还不完全一致。
 * 收成一个组件之后，改样子只改这里。
 */
export default function BackButton({ onClick }: Props) {
  return (
    <button type="button" className={styles.back} onClick={onClick} aria-label="返回">
      <span className={styles.chevron} aria-hidden="true" />
    </button>
  )
}
