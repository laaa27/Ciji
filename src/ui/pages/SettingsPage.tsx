import { useSession } from '@/store/session'

import { useSubView } from '../hooks/useSubView'
import ModelProfiles from '../components/ModelProfiles'
import MemoAccount from '../components/settings/MemoAccount'
import LookupPrefs from '../components/settings/LookupPrefs'
import AppearancePrefs from '../components/settings/AppearancePrefs'
import DataPrefs from '../components/settings/DataPrefs'
import AboutPanel from '../components/settings/AboutPanel'

import styles from './SettingsPage.module.css'

/**
 * 设置页：分类导航结构。
 *
 * 根视图只列栏目入口（一行一个：名称 + 一句话简介 + 状态摘要），
 * 点进去是二级界面做细分设置——原先把十几块设置全堆在一页上，
 * 滚动找东西靠眼力，拆开后每类的事都在它自己的页里。
 *
 * 进出动画沿用阅读板块文章库的方向感：进去从右边推进来（lib-in），
 * 返回时主视图从左边回来一点（back-in），安卓返回键先退设置层级再考虑退出 App。
 */

type SubPage = 'memo' | 'models' | 'lookup' | 'appearance' | 'data' | 'about'

const CATEGORIES: { id: SubPage; title: string; desc: string }[] = [
  {
    id: 'memo',
    title: '墨墨账号',
    desc: '连接墨墨开放 API，同步每天的学习记录与逐词反馈',
  },
  {
    id: 'models',
    title: '大模型',
    desc: '生成文章与查词释义用的模型，可存多份配置，思考模式分开开关',
  },
  {
    id: 'lookup',
    title: '查词与释义',
    desc: '本地词库 → AI 释义 → 联网补查，三层查询的优先级与开关',
  },
  {
    id: 'appearance',
    title: '外观',
    desc: '白天 / 深夜主题，液态玻璃底栏与不透明度',
  },
  {
    id: 'data',
    title: '数据',
    desc: '导出备份、导入合并、清空记录——数据只存在这台设备上',
  },
  {
    id: 'about',
    title: '关于',
    desc: '版本信息与开源地址',
  },
]

export default function SettingsPage() {
  const token = useSession((s) => s.token)
  /** 二级视图：六个设置栏目。返回动画、返回键都由 useSubView 接管 */
  const nav = useSubView<SubPage>()

  const activeCat = nav.view ? CATEGORIES.find((c) => c.id === nav.view) : null

  return (
    <div className={styles.page} data-view={nav.view ?? 'root'} data-return={nav.returning}>
      {nav.view === null ? (
        <>
          <h1 className={styles.title}>设置</h1>

          <ul className={styles.cats}>
            {CATEGORIES.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  className={styles.catRow}
                  onClick={() => nav.open(cat.id)}
                >
                  <span className={styles.catText}>
                    <span className={styles.catName}>
                      {cat.title}
                      {cat.id === 'memo' && (
                        <span className={styles.catMeta} data-on={Boolean(token)}>
                          {token ? '已连接' : '未连接'}
                        </span>
                      )}
                    </span>
                    <span className={styles.catDesc}>{cat.desc}</span>
                  </span>
                  <span className={styles.chevron} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <header className={styles.subHead}>
            <button type="button" className={styles.back} onClick={nav.close}>
              返回
            </button>
            <h1 className={styles.subTitle}>{activeCat?.title}</h1>
          </header>

          {nav.view === 'memo' && <MemoAccount />}
          {nav.view === 'models' && (
            <section className={styles.section}>
              <ModelProfiles />
            </section>
          )}
          {nav.view === 'lookup' && <LookupPrefs />}
          {nav.view === 'appearance' && <AppearancePrefs />}
          {nav.view === 'data' && <DataPrefs />}
          {nav.view === 'about' && <AboutPanel />}
        </>
      )}
    </div>
  )
}
