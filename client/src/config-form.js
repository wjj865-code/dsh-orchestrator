/**
 * 插件页配置卡片（P10 / Q1–Q5）：把 `src/config-fields.js` 的字段表渲染成可编辑表单。
 *
 * 平台契约（都是核实过的，改之前先读）：
 *
 * 1. **注册位置**：`plugins.bundle.config` 是 plugin-manager 页面声明的 keyed slot，
 *    key = **bundle 的包名**（`@wjj865-code/dsh-orchestrator`），渲染在 bundle 页面的
 *    「描述」与「行列表」之间，只接受 `view: 'page'`。
 * 2. **`configForms.get()` 的 key 是 Loader 的 entry id**（`cordis.patch.yml` 里那个
 *    `id: orchestrator`），**不是**包名。两处 key 不同源，写错任一处都是静默不渲染。
 * 3. **`whileServed(namespaces, register)`** 只在宿主正服务这些 namespace 时注册；
 *    插件没加载 / 被禁用时页面**完全无痕**（不留空壳、不报错）。
 * 4. 宿主只给「值 + 写操作」，**不生成表单**：本文件自己画控件、自己管草稿。
 *    0.2.2-rc.3 的 `autoGenerate` 字段没有任何 client 消费方（已全 asar 核实）。
 * 5. 写通道 `form.mutate(ops, expectedRevision)` 带 revision 栅栏：别人先改过就拒绝，
 *    我们**不静默覆盖**，而是保留草稿 + 提示重读。
 *
 * 状态机（`status`）：
 *   `loading`     → 首次快照还没到
 *   `unavailable` → 宿主没服务这个 namespace（插件没加载）
 *   `ready`       → 有值可渲染；`writable === false` 时整表只读
 * 草稿（`draft`）与 `saved` 分离：只有点「保存」才 `mutate`，离开页面草稿即丢弃（与平台一致）。
 */
import { FIELDS_BY_GROUP } from '../../src/config-fields.js'
import {
  buildOps, isDirty, parseInput, plainValues, overriddenKeys,
  COLLAPSED_BY_DEFAULT, CONFIG_ENTRY_ID, CONFIG_SLOT_KEY,
} from './config-logic.js'

// 两个 key 从这里再导出一次：client.js 只 import config-form.js，不必知道它们放在 logic 里。
export { CONFIG_ENTRY_ID, CONFIG_SLOT_KEY }

/**
 * 造配置卡片组件。
 * @param {object} deps 依赖注入（React 只能从 factory 拿，源码不许 import）。
 * @param {Function} deps.React React 本体。
 * @param {Function} deps.h createElement 别名。
 * @param {object} deps.Icon 图标组件。
 * @returns {Function} 卡片组件。
 */
export function createConfigCard({ React, h, Icon }) {
  /**
   * 订阅一个 ConfigForm（getSnapshot/subscribe），返回当前快照。
   * 宿主对象可能在挂载后才就绪，所以每次渲染都重新取；`undefined` 时给一个稳定的占位快照。
   * @param {object|undefined} form `configForms.get(entryId)` 的返回值。
   * @returns {object} 快照。
   */
  const useFormSnapshot = form => {
    const [, bump] = React.useState(0)
    React.useEffect(() => {
      if (form === undefined || form === null || typeof form.subscribe !== 'function') return undefined
      return form.subscribe(() => bump(value => value + 1))
    }, [form])
    if (form === undefined || form === null || typeof form.getSnapshot !== 'function') {
      return { status: 'loading', value: undefined, user: undefined, revision: undefined, writable: false }
    }
    return form.getSnapshot()
  }

  const Row = ({ field, draft, overridden, disabled, onChange }) => {
    const value = draft[field.key]
    const isOverridden = overridden.has(field.key)
    const common = {
      className: 'orch-cfg-input',
      disabled: disabled || field.readonly === true,
      value: value === undefined || value === null ? '' : String(value),
      onChange: event => onChange(field, event.target.value),
      'aria-label': field.label,
    }
    return (
      <div className="orch-cfg-row">
        <div className="orch-cfg-label">
          <span className="orch-cfg-name">{field.label}</span>
          {isOverridden ? <span className="orch-cfg-tag">已覆盖</span> : null}
          {field.readonly === true ? <span className="orch-cfg-tag orch-cfg-tag--readonly">只读</span> : null}
        </div>
        <div className="orch-cfg-control">
          {field.kind === 'boolean' ? (
            <button
              type="button"
              role="switch"
              aria-checked={value === true}
              aria-label={field.label}
              className={value === true ? 'orch-cfg-switch orch-cfg-switch--on' : 'orch-cfg-switch'}
              disabled={disabled || field.readonly === true}
              onClick={() => onChange(field, value !== true)}
            >
              <span className="orch-cfg-switch-knob" />
            </button>
          ) : field.kind === 'enum' ? (
            <select {...common}>
              {field.values.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input
              {...common}
              type={field.kind === 'number' ? 'number' : 'text'}
              placeholder={field.kind === 'number' ? String(field.default) : ''}
            />
          )}
        </div>
        {field.hint === undefined ? null : <div className="orch-cfg-hint">{field.hint}</div>}
        {field.pattern !== undefined && value !== '' && !new RegExp(field.pattern).test(String(value))
          ? <div className="orch-cfg-hint orch-cfg-hint--warn">格式不符（例：09:00）；非法值保存后会回落默认</div>
          : null}
      </div>
    )
  }

  /**
   * 卡片本体。
   * @param {object} props slot 注入的 props。
   * @param {object} props.form `ConfigPageForm`：{ state, mutate(ops, revision) }。
   * @param {string} props.view `'page'`（bundle 页只用这个）。
   * @returns {object|null} 组件树。
   */
  return function OrchestratorConfigCard(props) {
    const form = props.form
    const snapshot = useFormSnapshot(form === undefined ? undefined : form)
    const saved = React.useMemo(() => plainValues(snapshot.value), [snapshot.value])
    const overridden = React.useMemo(() => overriddenKeys(snapshot.user), [snapshot.user])
    const [draft, setDraft] = React.useState(saved)
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [notice, setNotice] = React.useState(null)
    const [collapsed, setCollapsed] = React.useState(() => new Set(COLLAPSED_BY_DEFAULT))

    // 宿主值刷新（保存成功 / 别处改动）时重置草稿：未保存的编辑会丢，但那是「值已变」的必然代价，
    // 保住草稿反而会让用户看到一份与生效值不符的表单。
    React.useEffect(() => {
      setDraft(saved)
      setError(null)
    }, [saved])

    const dirty = isDirty(draft, saved)
    const readonly = snapshot.writable !== true

    const onChange = (field, next) => {
      setNotice(null)
      setDraft(current => ({ ...current, [field.key]: field.kind === 'string' || field.kind === 'enum'
        ? next
        : parseInput(field, next) }))
    }

    const onSave = async () => {
      if (form === undefined || typeof form.mutate !== 'function') return
      const ops = buildOps(draft, saved, overridden)
      if (ops.length === 0) {
        setNotice('没有需要保存的改动')
        return
      }
      setSaving(true)
      setError(null)
      setNotice(null)
      try {
        const accepted = await form.mutate(ops, snapshot.revision)
        if (accepted === true) {
          // 保存会触发插件重载（台账不丢，但 watchdog/轮换计时器会重置）——明确告诉用户。
          setNotice('已保存。配置即时生效（插件会重载，台账不受影响）。')
        } else {
          setError('保存被拒绝：配置可能已被别处改动，或该字段不允许写入。表单已按最新值刷新，请重试。')
        }
      } catch (failure) {
        setError(`保存失败：${String((failure && failure.message) || failure)}`)
      } finally {
        setSaving(false)
      }
    }

    const onReset = () => {
      setDraft(saved)
      setError(null)
      setNotice('已放弃未保存的改动')
    }

    const toggleGroup = id => setCollapsed(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

    if (snapshot.status === 'unavailable') {
      return h('div', { className: 'orch-cfg orch-cfg--empty' }, [
        h('div', { key: 'title', className: 'orch-cfg-title' }, '配置'),
        h('p', { key: 'body', className: 'orch-cfg-hint' }, '该插件当前未加载，暂时无法配置。'),
      ])
    }

    if (snapshot.status === 'loading') {
      return h('div', { className: 'orch-cfg orch-cfg--empty' }, [
        h('div', { key: 'title', className: 'orch-cfg-title' }, '配置'),
        h('p', { key: 'body', className: 'orch-cfg-hint' }, '正在读取配置…'),
      ])
    }

    const groups = FIELDS_BY_GROUP.map(group => {
      const isCollapsed = collapsed.has(group.id)
      const header = h('button', {
        key: 'header',
        type: 'button',
        className: 'orch-cfg-group-header',
        'aria-expanded': !isCollapsed,
        onClick: () => toggleGroup(group.id),
      }, [
        // 折叠时图标旋转 90°（同一条 chevron，靠 CSS 表达开合，不额外造图标）。
        h(Icon, { key: 'icon', name: 'chevron', className: isCollapsed ? 'orch-cfg-chevron' : 'orch-cfg-chevron orch-cfg-chevron--open' }),
        h('span', { key: 'label', className: 'orch-cfg-group-label' }, group.label),
        h('span', { key: 'count', className: 'orch-cfg-group-count' }, String(group.fields.length)),
      ])
      const body = isCollapsed ? null : h('div', { key: 'body', className: 'orch-cfg-group-body' },
        group.fields.map(field => h(Row, {
          key: field.key,
          field,
          draft,
          overridden,
          disabled: readonly || saving,
          onChange,
        })))
      return h('section', { key: group.id, className: 'orch-cfg-group' }, [header, body])
    })

    const actions = readonly ? null : h('div', { key: 'actions', className: 'orch-cfg-actions' }, [
      h('button', {
        key: 'save',
        type: 'button',
        className: 'orch-btn orch-btn--primary',
        disabled: !dirty || saving,
        onClick: onSave,
      }, saving ? '保存中…' : '保存'),
      h('button', {
        key: 'reset',
        type: 'button',
        className: 'orch-btn',
        disabled: !dirty || saving,
        onClick: onReset,
      }, '放弃改动'),
      dirty ? h('span', { key: 'dirty', className: 'orch-cfg-hint' }, '有未保存的改动') : null,
    ])

    return h('div', { className: 'orch-cfg', 'data-orchestrator-config': 'true' }, [
      h('div', { key: 'head', className: 'orch-cfg-head' }, [
        h('div', { key: 'title', className: 'orch-cfg-title' }, '配置'),
        readonly
          ? h('span', { key: 'ro', className: 'orch-cfg-tag orch-cfg-tag--readonly' }, '只读')
          : null,
      ]),
      h('p', { key: 'intro', className: 'orch-cfg-hint' },
        '保存在当前 profile 的 cordis.patch.yml；保存后插件即时重载（台账不受影响）。'),
      error === null ? null : h('div', { key: 'error', className: 'orch-banner orch-banner--error', role: 'alert' }, error),
      notice === null ? null : h('div', { key: 'notice', className: 'orch-banner orch-banner--info', role: 'status' }, notice),
      ...groups,
      actions,
    ])
  }
}
