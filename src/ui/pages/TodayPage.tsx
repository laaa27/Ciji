import WordRow, { type WordState } from '../components/WordRow'
import styles from './TodayPage.module.css'

type Item = {
  spelling: string
  gloss: string
  state: WordState
  note?: string
}

const MOCK_GROUPS: { key: WordState; title: string; items: Item[] }[] = [
  {
    key: 'new',
    title: '新学',
    items: [
      { spelling: 'abandon', gloss: 'v. 放弃，抛弃；离弃，逃离', state: 'new' },
      { spelling: 'inherent', gloss: 'adj. 固有的，内在的，与生俱来的', state: 'new' },
      { spelling: 'scrutiny', gloss: 'n. 仔细检查，详细审查', state: 'new' },
    ],
  },
  {
    key: 'vague',
    title: '模糊',
    items: [
      {
        spelling: 'prevalent',
        gloss: 'adj. 流行的，盛行的，普遍的',
        state: 'vague',
        note: '初模糊 → 终认识',
      },
      { spelling: 'concede', gloss: 'v. 承认；让步；勉强同意', state: 'vague' },
    ],
  },
  {
    key: 'forget',
    title: '忘记',
    items: [
      {
        spelling: 'eloquent',
        gloss: 'adj. 雄辩的，有说服力的；意味深长的',
        state: 'forget',
        note: '初忘记 → 终模糊',
      },
      { spelling: 'reluctant', gloss: 'adj. 不情愿的，勉强的', state: 'forget' },
    ],
  },
]

export default function TodayPage() {
  const finished = 32
  const total = 150
  const minutes = 24
  const pct = Math.min(100, (finished / total) * 100)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.dateRow}>
          <h1 className={styles.date}>11月7日</h1>
          <span className={styles.weekday}>星期六</span>
        </div>

        <div className={styles.progress}>
          <div className={styles.progressLine}>
            <span className={styles.progressMain}>
              <span className={styles.progressNum}>{finished}</span>
              <span className={styles.progressSlash}>/</span>
              <span className={styles.progressTotal}>{total}</span>
            </span>
            <span className={styles.progressTime}>{minutes} 分钟</span>
          </div>
          <div className={styles.track}>
            <div className={styles.fill} style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      {MOCK_GROUPS.map((group) => (
        <section key={group.key} className={styles.group}>
          <div className={styles.groupHead}>
            <h2 className={styles.groupTitle}>{group.title}</h2>
            <span className={styles.groupCount}>{group.items.length}</span>
          </div>

          {group.items.length === 0 ? (
            <p className={styles.empty}>这一组今天没有词</p>
          ) : (
            <ul>
              {group.items.map((item) => (
                <WordRow
                  key={item.spelling}
                  spelling={item.spelling}
                  gloss={item.gloss}
                  state={item.state}
                  note={item.note}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
