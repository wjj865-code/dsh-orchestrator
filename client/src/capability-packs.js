/**
 * 能力包面板（0.32.0 / P4）。
 *
 * 为什么是独立面板 key 而不是塞进工作台：能力包是「另一类东西」——它不是任务台账的一部分，
 * 也不该出现在任务筛选/排期里；独立 main panel（侧栏「能力包」）让边界一眼可见。
 *
 * 数据：`pack-snapshot`（只读投影，15s 轮询；不写盘、不 spawn）。写动作只有四个窄口：
 * 开包会话 / 装卸载 CLI / 环境变量 / 删除用户包 —— 每个都由宿主侧再判 confirm（按钮不是授权）。
 *
 * 安全：环境变量的值只在本组件的 input state 里存在，提交后立刻清空；面板从不显示值、
 * 不显示长度、不写日志；「复制设置命令」复制的是带 `<你的值>` 占位符的命令。
 */
import { PACK_POLL_MS } from './constants.js'
import { openSessionWhenReady } from './open-session.js'
import {
  readPackSnapshot, openPackSession, installPackCli, uninstallPackCli, deletePack,
  copyPackEnvCommand, setPackEnv,
} from './api.js'

const STATUS_LABEL = {
  installed: '已安装',
  'not-installed': '未安装',
  outdated: '可升级',
  failed: '安装失败',
  broken: '入口缺失',
  uninstalled: '已卸载',
  unknown: '未知',
}

const fmtMiB = size => (size === undefined || size === null ? '' : `${size} MiB`)
const secondsText = seconds => {
  if (!Number.isFinite(seconds)) return ''
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${seconds} 秒`
}

const errorText = failure => String((failure && failure.message) || failure)

export function createCapabilityPacksPanel({
  React, h, Icon, Badge, Chip, EmptyState, Banner, SkeletonList,
}) {
  const { useState, useEffect, useRef } = React

  const copyText = async text => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /** 安装确认卡：默认焦点在「取消」；确认后带 planHash 执行。 */
  const InstallCard = ({ pack, cli, onCancel, onDone }) => {
    const plan = cli.plan
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState(null)
    const run = async () => {
      setBusy(true)
      setMessage(null)
      try {
        const body = await installPackCli(pack.id, cli.id, plan.planHash)
        setMessage({ tone: 'good', text: body.reused === true ? '已安装同版本，直接复用。' : `已安装 ${plan.package}@${plan.version}。` })
        onDone()
      } catch (failure) {
        setMessage({ tone: 'bad', text: `安装失败：${errorText(failure)}` })
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="orch-pack-confirm" role="group" aria-label="安装确认">
        <div className="orch-pack-confirm-title">{`安装 ${plan.package}@${plan.version}`}</div>
        <div className="orch-pack-kv"><span>管理器</span><b>{`${plan.manager}（${plan.scope}）`}</b></div>
        <div className="orch-pack-kv"><span>registry</span><b>{plan.registry}</b></div>
        <div className="orch-pack-kv"><span>integrity</span><b className="orch-pack-mono">{plan.integrity}</b></div>
        <div className="orch-pack-kv"><span>license</span><b>{plan.license}</b></div>
        <div className="orch-pack-kv"><span>argv</span><b className="orch-pack-mono">{plan.argv === undefined ? plan.manualCommand : plan.argv.join(' ')}</b></div>
        <div className="orch-pack-kv"><span>体积</span><b>{`≈ ${fmtMiB(plan.size.unpackedMiB)}（${plan.size.packages} 个包；store ≈ ${fmtMiB(plan.size.storeMiB)} 可共享）`}</b></div>
        <div className="orch-pack-kv"><span>耗时</span><b>{`冷装 ≈ ${secondsText(plan.size.coldSeconds)}，热装 ≈ ${secondsText(plan.size.warmSeconds)}`}</b></div>
        <ul className="orch-pack-notes">
          {plan.impact.map(item => <li key={item}>{item}</li>)}
          <li>{`卸载：${plan.uninstall}`}</li>
          <li>{`失败：${plan.failure}`}</li>
        </ul>
        {message === null ? null : <div className={message.tone === 'good' ? 'orch-pack-ok' : 'orch-pack-err'}>{message.text}</div>}
        <div className="orch-card-actions">
          <button type="button" className="orch-btn orch-btn--sm" onClick={onCancel} disabled={busy}>取消（推荐先取消）</button>
          <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={run} disabled={busy || plan.runnable !== true}>
            {busy ? '安装中…' : '确认安装'}
          </button>
        </div>
        {plan.runnable === true ? null : <div className="orch-pack-err">{`当前环境找不到 node/pnpm：可复制手动命令 ${plan.manualCommand}`}</div>}
      </div>
    )
  }

  /** 环境变量段：只显示存在性；复制命令 / 由插件设置（二次确认）。 */
  const EnvSection = ({ pack, onRefresh }) => {
    const [copied, setCopied] = useState(null)
    const [editing, setEditing] = useState(null)
    const [value, setValue] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState(null)
    const copy = async ref => {
      try {
        const body = await copyPackEnvCommand(pack.id, ref)
        const ok = await copyText(body.command)
        setCopied({ ref, ok })
      } catch (failure) {
        setMessage({ tone: 'bad', text: errorText(failure) })
      }
    }
    const submit = async ref => {
      setBusy(true)
      setMessage(null)
      try {
        await setPackEnv(pack.id, ref, value)
        setValue('')
        setEditing(null)
        setMessage({ tone: 'good', text: '已写入（用户环境变量）。必须彻底退出 DSH 再启动才生效。' })
        onRefresh()
      } catch (failure) {
        setMessage({ tone: 'bad', text: `设置失败：${errorText(failure)}` })
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="orch-pack-env">
        <div className="orch-pack-confirm-title">{'环境变量（只显示是否设置，永不显示值）'}</div>
        {pack.env.length === 0 ? <div className="orch-pack-muted">{'本包没有声明环境变量。'}</div> : null}
        {pack.env.map(item => (
          <div key={item.ref} className="orch-pack-env-row">
            <div className="orch-pack-env-head">
              <b className="orch-pack-mono">{item.ref}</b>
              <Chip tone={item.set ? 'good' : 'warn'}>{item.set ? '已设置' : '未设置'}</Chip>
              <span className="orch-pack-muted">{`${item.kind}${item.required ? '｜必填' : ''}｜${item.purpose}`}</span>
            </div>
            <div className="orch-card-actions">
              <button type="button" className="orch-btn orch-btn--sm" onClick={() => copy(item.ref)}>{copied?.ref === item.ref && copied.ok ? '已复制' : '复制设置命令'}</button>
              {item.set ? null : (
                <button type="button" className="orch-btn orch-btn--sm" onClick={() => { setEditing(item.ref); setValue('') }}>
                  {'由插件设置'}
                </button>
              )}
            </div>
            {editing !== item.ref ? null : (
              <div className="orch-pack-env-edit">
                <div className="orch-pack-err">{'确认后会把值写进 HKCU\\Environment；密钥会短暂出现在 setx 命令行；值不落盘、不记日志。'}</div>
                <input
                  className="orch-input orch-pack-mono" type="password" autoComplete="off" value={value}
                  placeholder="粘贴值（不会显示、不会回传）" onChange={event => setValue(event.target.value)}
                />
                <div className="orch-card-actions">
                  <button type="button" className="orch-btn orch-btn--sm" onClick={() => { setEditing(null); setValue('') }} disabled={busy}>取消</button>
                  <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={() => submit(item.ref)} disabled={busy || value === ''}>
                    {busy ? '写入中…' : '确认写入'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {message === null ? null : <div className={message.tone === 'good' ? 'orch-pack-ok' : 'orch-pack-err'}>{message.text}</div>}
        <div className="orch-pack-muted">{'设置后需彻底退出 DSH 再启动。'}</div>
      </div>
    )
  }

  const PackCard = ({ pack, onChanged, openSession }) => {
    const [confirming, setConfirming] = useState(null)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState(null)
    const [envOpen, setEnvOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const cli = pack.cli && pack.cli.length > 0 ? pack.cli[0] : null
    const open = async () => {
      setBusy(true)
      setMessage(null)
      try {
        const body = await openPackSession(pack.id)
        // 会话已建好；「切过去」还要等客户端会话目录收到新行（见 open-session.js）。
        const outcome = await openSessionWhenReady(openSession, body?.sessionId)
        if (!outcome.ok) {
          setMessage({
            tone: 'bad',
            text: `已建好（${body?.sessionId}），但打不开：${outcome.reason}。请从左侧列表打开。`,
          })
        }
      } catch (failure) {
        setMessage({ tone: 'bad', text: `开包会话失败：${errorText(failure)}` })
      } finally {
        setBusy(false)
      }
    }
    const uninstall = async () => {
      setBusy(true)
      setMessage(null)
      try {
        await uninstallPackCli(pack.id, cli.id)
        setMessage({ tone: 'good', text: '已卸载 CLI（包与技能保留）。' })
        onChanged()
      } catch (failure) {
        setMessage({ tone: 'bad', text: `卸载失败：${errorText(failure)}` })
      } finally {
        setBusy(false)
      }
    }
    const remove = async () => {
      setBusy(true)
      setMessage(null)
      try {
        await deletePack(pack.id)
        setMessage({ tone: 'good', text: '已删除：预设已撤销，包目录进 .trash 保留 24h。' })
        setDeleteOpen(false)
        onChanged()
      } catch (failure) {
        setMessage({ tone: 'bad', text: `删除失败：${errorText(failure)}` })
      } finally {
        setBusy(false)
      }
    }
    return (
      <section className="orch-card orch-pack" aria-label={pack.name}>
        <div className="orch-card-top">
          <div>
            <div className="orch-card-title">
              {pack.name}
              {' '}
              <Badge tone={pack.kind === 'builtin' ? 'info' : 'muted'}>{pack.kind === 'builtin' ? '内置' : '用户包'}</Badge>
              {' '}
              <span className="orch-pack-muted">{`v${pack.version}`}</span>
            </div>
            <div className="orch-card-meta">{`${pack.publisher}｜技能 ${pack.skills.length}｜${pack.presetRegistered ? '预设已注册' : '预设未注册'}`}</div>
          </div>
          <Chip tone={pack.health.ok === true ? 'good' : 'warn'}>{pack.healthLine}</Chip>
        </div>
        <div className="orch-pack-rows">
          <div className="orch-pack-kv">
            <span>CLI</span>
            <b>{cli === null ? '本包不依赖 CLI' : `${cli.package}@${cli.version}｜${STATUS_LABEL[cli.status] ?? cli.status}`}</b>
          </div>
          <div className="orch-pack-kv"><span>目录</span><b className="orch-pack-mono">{pack.dir}</b></div>
          <div className="orch-pack-kv">
            <span>环境变量</span>
            <b>{pack.env.length === 0 ? '无' : pack.env.map(item => `${item.ref}=${item.set ? '已设置' : '未设置'}`).join('，')}</b>
          </div>
        </div>
        <div className="orch-card-actions">
          <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={open} disabled={busy || pack.presetRegistered !== true}>
            {'用这个包开新会话'}
          </button>
          {cli === null ? null : (cli.status === 'installed' || cli.status === 'outdated'
            ? (
              <button type="button" className="orch-btn orch-btn--sm" onClick={uninstall} disabled={busy}>{'卸载 CLI'}</button>
            )
            : (
              <button type="button" className="orch-btn orch-btn--sm" onClick={() => setConfirming(cli.plan)} disabled={busy || cli.plan === undefined}>
                {cli.status === 'failed' ? '重试安装 CLI' : '安装 CLI'}
              </button>
            ))}
          <button type="button" className="orch-btn orch-btn--sm" onClick={() => setEnvOpen(value => !value)}>{envOpen ? '收起环境变量' : '环境变量'}</button>
          {pack.deletable ? (
            <button type="button" className="orch-btn orch-btn--danger orch-btn--sm" onClick={() => setDeleteOpen(true)} disabled={busy}>{'删除'}</button>
          ) : null}
        </div>
        {message === null ? null : <div className={message.tone === 'good' ? 'orch-pack-ok' : 'orch-pack-err'}>{message.text}</div>}
        {deleteOpen ? (
          <div className="orch-pack-confirm">
            <div className="orch-pack-confirm-title">{`删除「${pack.name}」？`}</div>
            <ul className="orch-pack-notes">
              <li>{'撤销预设（已开着的会话按平台语义保旧 revision，结束后失效）'}</li>
              <li>{'包目录移进 .trash 保留 24h；可手工从 .trash 恢复'}</li>
              <li>{`删除 tools/${pack.id}（CLI 需重装）`}</li>
            </ul>
            <div className="orch-card-actions">
              <button type="button" className="orch-btn orch-btn--sm" onClick={() => setDeleteOpen(false)} disabled={busy}>{'取消'}</button>
              <button type="button" className="orch-btn orch-btn--danger orch-btn--sm" onClick={remove} disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
            </div>
          </div>
        ) : null}
        {envOpen ? <EnvSection pack={pack} onRefresh={onChanged} /> : null}
        {confirming === null ? null : (
          <InstallCard pack={pack} cli={{ ...cli, plan: confirming }} onCancel={() => setConfirming(null)} onDone={() => { setConfirming(null); onChanged() }} />
        )}
      </section>
    )
  }

  const CapabilityPacksPanel = ({ openSession }) => {
    const [state, setState] = useState({ loading: true, error: null, data: null })
    const tick = useRef(false)
    const load = async () => {
      if (tick.current) return
      tick.current = true
      try {
        const data = await readPackSnapshot()
        setState({ loading: false, error: null, data })
      } catch (failure) {
        setState(previous => ({ loading: false, error: errorText(failure), data: previous.data }))
      } finally {
        tick.current = false
      }
    }
    useEffect(() => {
      let cancelled = false
      let timer
      const run = async () => {
        if (cancelled) return
        await load()
        if (!cancelled) timer = setTimeout(run, PACK_POLL_MS)
      }
      run()
      return () => {
        cancelled = true
        try { clearTimeout(timer) } catch { /* 卸载期清理失败不阻断 */ }
      }
    }, [])
    const data = state.data
    const packs = data?.packs ?? []
    return (
      <div className="orch-body orch-body--packs">
        <main className="orch-main orch-packs-shell">
          <header className="orch-packs-head">
            <div className="orch-card-title">
              <Icon name="sparkle" size={14} />
              {'能力包'}
            </div>
            <button type="button" className="orch-btn orch-btn--sm" onClick={load}>{'刷新'}</button>
          </header>
          {state.error === null ? null : <Banner tone="error">{state.error}</Banner>}
          {data !== null && data.usable !== true ? (
            <Banner tone="info">{data.error ?? '能力包当前不可用（Desktop-only 或被配置停用）。'}</Banner>
          ) : null}
          {state.loading && data === null ? <SkeletonList rows={3} /> : null}
          {state.loading === false && data !== null && packs.length === 0 ? (
            <EmptyState icon="sparkle" title="还没有能力包" hint="内置「公众号文章」应随插件提供；用户包由协调者用 capability_pack 创建。" />
          ) : null}
          {packs.map(pack => (pack.error !== undefined
            ? <section key={pack.id} className="orch-card orch-pack"><div className="orch-card-title">{pack.id}</div><div className="orch-pack-err">{`包损坏：${pack.error}`}</div></section>
            : (
              <PackCard
                key={`${pack.id}:${pack.version}`}
                pack={pack}
                onChanged={load}
                openSession={openSession}
              />
            )))}
        </main>
      </div>
    )
  }

  // 侧栏入口图标：与「主会话」入口同一规格（见 views.js 的 LauncherIcon 注释）——
  // 宿主把这格当行的直接图标子元素，边长由 `size` 传入（展开 16 / 收起 18），
  // 所以画成 size × size 的 SVG，而不是落成行盒基线上的字符 `◫`。
  const CapabilityPacksIcon = ({ size = 16 }) => (
    <Icon name="navPacks" size={size} className="orch-nav-glyph" />
  )

  return { CapabilityPacksPanel, CapabilityPacksIcon }
}
