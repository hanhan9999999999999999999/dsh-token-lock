/**
 * dsh-token-lock — 浏览器半边
 *
 * 作用：在 DSH 设置界面左侧栏注册一个分区，把插件的全部开关摊开给用户。
 *
 * 为什么不用宿主的 configForms：
 *   configForms 绑的是「宿主配置命名空间」（ctx.remote.settings.mutate），
 *   而本插件的配置是自有 JSON + 运行期内存（runtime.patchConfig），
 *   硬塞进宿主表单只会让两边各存一份、互相打架。
 *   所以这里自带 UI，数据走插件自己的 HTTP 路由（同源，requestRejection 放行）。
 *
 * 宿主加载方式：package.json 的 exports["./client"] + dsh.client.platform = "web"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-lock',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    /** locale 命名空间；同时也是 CSS 类名前缀的来源。 */
    const NS = 'token-lock';
    /** 只依赖这两个服务：slots 挂分区，locale 拿译文。 */
    const inject = ['slots', 'locale'];
    /** 路由前缀，必须与 src/routes.js 的 PREFIX 一致。 */
    const API = '/token-lock';

    // ── 文案 ──────────────────────────────────────────────────
    const zh = {
      nav: 'Token 护栏',
      title: 'Token 护栏',
      intro: '控制 dsh-token-lock 的每一道闸。默认只有提示、不拦任何请求。',
      loading: '正在读取配置…',
      failed: '读不到插件配置',
      retry: '重试',
      saved: '已保存',
      saveFailed: '保存失败',
      locked: '影子样本不足或误伤率过高，暂时不能切到 enforce',
      on: '开',
      off: '关',
      secPosture: '运行姿态',
      secDims: '七个限制维度',
      secDetectors: '检测器',
      secLevels: '强度阶梯',
      secExempt: '豁免通道',
      secNumbers: '数值阈值',
      postureMode: '模式',
      postureDryRun: '只记账不执行',
      postureEnabled: '插件总开关',
      modeObserve: 'observe · 只记录',
      modeAdvise: 'advise · 提示但不拦',
      modeEnforce: 'enforce · 真正拦截',
      today: '今日消耗',
      shadow: '影子判定',
      samples: '样本',
      falsePositive: '误伤率',
      maxLevel: '最高档位',
      throttle: '节流间隔（ms）',
      daily: '每日预算（token，0 = 不限）',
      session: '单会话预算（token，0 = 不限）',
      hint: '改完立即生效，无需重启；重启后回到配置文件里的值。',
    };
    const en = {
      nav: 'Token Guard',
      title: 'Token Guard',
      intro: 'Every gate of dsh-token-lock. The default only advises — it never blocks a request.',
      loading: 'Reading configuration…',
      failed: 'Could not read the plugin configuration',
      retry: 'Retry',
      saved: 'Saved',
      saveFailed: 'Save failed',
      locked: 'Not enough shadow samples, or the false-positive rate is too high — enforce is unavailable',
      on: 'On',
      off: 'Off',
      secPosture: 'Posture',
      secDims: 'Seven dimensions',
      secDetectors: 'Detectors',
      secLevels: 'Level ladder',
      secExempt: 'Exemptions',
      secNumbers: 'Numeric thresholds',
      postureMode: 'Mode',
      postureDryRun: 'Record only',
      postureEnabled: 'Plugin master switch',
      modeObserve: 'observe · record only',
      modeAdvise: 'advise · hint, never block',
      modeEnforce: 'enforce · actually block',
      today: 'Today',
      shadow: 'Shadow',
      samples: 'samples',
      falsePositive: 'false positives',
      maxLevel: 'Ceiling level',
      throttle: 'Throttle interval (ms)',
      daily: 'Daily budget (tokens, 0 = unlimited)',
      session: 'Per-session budget (tokens, 0 = unlimited)',
      hint: 'Changes apply immediately, no restart; a restart restores the values from the config file.',
    };

    // ── 静态说明表（键必须与 src/config.js 一致） ──────────────
    const DIMS = [
      ['d1', '时间', '按时间窗判断调用频次与突发'],
      ['d2', '内容', '重复读同一段、重复跑同一条命令'],
      ['d3', '行为', '空转、连环失败、长时间无产出（唯一够格拒绝的维度）'],
      ['d4', '结构', '上下文膨胀、图片堆积、增量过大'],
      ['d5', '成本', '日预算 / 会话预算'],
      ['d6', '调度', '并发子代理与派发的预算（唯一够格拒绝的维度）'],
      ['d7', '项目', '跨项目基线对比（默认关）'],
    ];
    const DETECTORS = [
      ['p0', '派发前预检', '动手前先看这次派发值不值'],
      ['p1', '压缩 ROI 门', '压缩收益低于成本时提示'],
      ['s1', '重复读取', '同一区间被反复读'],
      ['s2', '重复命令', '同一条命令反复跑'],
      ['s3', '连环失败', '同一动作连续失败'],
      ['s4', '空转', '连续若干轮没有产出'],
      ['s5', '上下文膨胀', '上下文超过阈值'],
      ['s6', '上下文增量', '单轮增量异常'],
      ['s7', '死胡同', '长时间没有写入'],
      ['s8', '产出率过低', '每万 token 的产出低于基线'],
      ['s9', '图片过多', '单次请求带图数量超限'],
      ['s10', '日预算', '当日消耗触顶'],
      ['s11', '子代理并发', '同时跑的子代理过多'],
    ];
    const LEVELS = [
      ['r0', '静默放行', '什么也不做'],
      ['r1', '记账', '只记一笔'],
      ['r2', '记录 + 提示', '写一行提示，不打断'],
      ['r3', '提示 + 节流', '默认上限：提示并轻微延迟'],
      ['r4', '强化提示', '更强的提示文案'],
      ['r5', '要求确认', '需要用户确认'],
      ['r6', '强提示', '显著提醒，仍不改行为'],
      ['r7', '拒绝', '真正拦下（仅 d3 / d6 够格）'],
    ];
    const EXEMPTS = [
      ['e1', '用户显式要求', '用户刚开口要的，最高 r3'],
      ['e2', '首轮', '新会话头几轮最高 r2'],
      ['e3', '长任务', '已知长任务最高 r6'],
      ['e4', '白名单', '命中的项目/工具/路径最高 r0'],
      ['e5', '解锁令牌', '手动解锁 10 分钟内最高 r1'],
      ['e6', '预算弹性', '预算上浮到 P95×1.2'],
      ['e7', '学习期', '前 20 个会话最高 r2'],
    ];
    const MODES = ['observe', 'advise', 'enforce'];

    // ── 样式（一次注入，明暗主题都用半透明色，不吃宿主的调色板） ──
    const CSS = `
.tl-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; }
.tl-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.tl-title { font-size: 15px; font-weight: 600; margin: 0; color: inherit; }
.tl-intro { font-size: 12px; opacity: .62; margin: 0; flex: 1 1 260px; }
.tl-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); opacity: .8; }
.tl-stats { display: flex; gap: 10px; flex-wrap: wrap; }
.tl-stat { flex: 1 1 120px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; padding: 8px 10px; background: rgba(127,127,127,.05); }
.tl-stat-k { font-size: 11px; opacity: .6; }
.tl-stat-v { font-size: 14px; font-weight: 600; margin-top: 2px; }
.tl-sec { border: 1px solid rgba(127,127,127,.22); border-radius: 10px; overflow: hidden; }
.tl-sec-h { font-size: 12px; font-weight: 600; padding: 8px 12px; background: rgba(127,127,127,.07); }
.tl-row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-top: 1px solid rgba(127,127,127,.12); }
.tl-row:first-of-type { border-top: none; }
.tl-row-t { flex: 1; min-width: 0; }
.tl-row-l { font-size: 13px; }
.tl-row-d { font-size: 11px; opacity: .58; margin-top: 2px; }
.tl-sw { flex: none; width: 38px; height: 21px; border-radius: 999px; border: 1px solid rgba(127,127,127,.4); background: rgba(127,127,127,.18); position: relative; cursor: pointer; transition: background .15s, border-color .15s; }
.tl-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.tl-sw[data-on="1"] { background: #3b82f6; border-color: #3b82f6; }
.tl-sw[data-on="1"]::after { transform: translateX(17px); }
.tl-sw[disabled] { opacity: .45; cursor: not-allowed; }
.tl-num { width: 120px; flex: none; font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.06); color: inherit; }
.tl-seg { display: flex; gap: 4px; flex: none; }
.tl-seg-b { font: inherit; font-size: 11px; padding: 4px 9px; border-radius: 6px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; opacity: .7; cursor: pointer; }
.tl-seg-b[data-on="1"] { background: rgba(59,130,246,.16); border-color: #3b82f6; opacity: 1; font-weight: 600; }
.tl-seg-b[disabled] { opacity: .35; cursor: not-allowed; }
.tl-note { font-size: 11px; opacity: .55; padding: 0 2px; }
.tl-err { font-size: 12px; color: #dc2626; }
.tl-toast { position: sticky; bottom: 0; font-size: 11px; padding: 4px 10px; border-radius: 6px; background: rgba(59,130,246,.14); align-self: flex-start; }
`;

    /** 注入样式表；同 id 只注入一次（HMR 重挂时也不会叠加）。 */
    function useStyle() {
      react.useEffect(() => {
        const id = 'dsh-token-lock-css';
        if (document.getElementById(id)) return;
        const el = document.createElement('style');
        el.id = id;
        el.setAttribute('data-plugin', NS);
        el.setAttribute('data-plugin-css', NS);
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    function row(key, label, desc, control) {
      return h('div', { className: 'tl-row', key },
        h('div', { className: 'tl-row-t' },
          h('div', { className: 'tl-row-l' }, label),
          desc ? h('div', { className: 'tl-row-d' }, desc) : null),
        control);
    }

    /** 开关：一个 role=switch 的按钮，不做动画依赖，键盘可用。 */
    function Toggle({ label, desc, value, disabled, onChange, t }) {
      return row(label, label, desc,
        h('button', {
          className: 'tl-sw',
          type: 'button',
          role: 'switch',
          'aria-checked': value ? 'true' : 'false',
          'aria-label': label,
          'data-on': value ? '1' : '0',
          title: value ? t('on') : t('off'),
          disabled: !!disabled,
          onClick: () => onChange(!value),
        }));
    }

    function Section({ title, children }) {
      return h('section', { className: 'tl-sec' },
        h('div', { className: 'tl-sec-h' }, title),
        children);
    }

    function TokenLockSection(props) {
      useStyle();
      const t = typeof props?.t === 'function' ? props.t : (k) => zh[k] ?? k;
      const [cfg, setCfg] = react.useState(null);
      const [status, setStatus] = react.useState(null);
      const [err, setErr] = react.useState(null);
      const [toast, setToast] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const alive = react.useRef(true);

      react.useEffect(() => () => { alive.current = false; }, []);

      /**
       * 一次读两个接口。
       * 不直接 .json()：拿不到路由时宿主给的是 404 空 body / 403 纯文本，
       * 直接解析只会抛 "Unexpected end of JSON input" 这种看不懂的话。
       * 这里先看状态码、再读文本、最后才解析，错误里带 Status 与 body 前 160 字。
       */
      const getJson = async (path) => {
        const res = await fetch(path, { headers: { accept: 'application/json' } });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`${path} → HTTP ${res.status} ${String(text || '').slice(0, 160).trim()}`);
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${path} → 返回的不是 JSON：${String(text || '空 body').slice(0, 160).trim()}`);
        }
      };

      const load = react.useCallback(async () => {
        try {
          const [a, b] = await Promise.all([getJson(`${API}/config`), getJson(`${API}/status`)]);
          if (!alive.current) return;
          if (a?.ok === false || b?.ok === false) throw new Error(a?.error ?? b?.error ?? 'bad response');
          setCfg(a.config ?? null);
          setStatus(b ?? null);
          setErr(null);
        } catch (e) {
          if (alive.current) setErr(String(e?.message ?? e));
        }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      /**
       * 提交一次改动。
       * 注意：runtime.patchConfig 是浅合并 —— 嵌套对象必须整体发，
       * 所以这里先合并本地子对象再发，绝不只发 {"d3": false}。
       */
      const patch = react.useCallback(async (partial, nextCfg) => {
        setBusy(true);
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ patch: partial }),
          });
          const raw = await res.text();
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          if (!res.ok || data?.ok === false) {
            throw new Error(data?.hint ?? data?.error ?? `HTTP ${res.status} ${String(raw || '').slice(0, 160).trim()}`);
          }
          if (!alive.current) return;
          setCfg(nextCfg);
          setToast({ kind: 'ok', text: t('saved') });
          load();
        } catch (e) {
          if (alive.current) setToast({ kind: 'err', text: `${t('saveFailed')}：${String(e?.message ?? e)}` });
          load();
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [load, t]);

      react.useEffect(() => {
        if (!toast) return;
        const id = setTimeout(() => setToast(null), 2600);
        return () => clearTimeout(id);
      }, [toast]);

      if (err && !cfg) {
        return h('div', { className: 'tl-root' },
          h('div', { className: 'tl-head' },
            h('h3', { className: 'tl-title' }, t('title')),
          ),
          h('div', { className: 'tl-err' }, `${t('failed')}：${err}`),
          h('div', null,
            h('button', { className: 'tl-seg-b', type: 'button', onClick: load }, t('retry'))));
      }

      if (!cfg) {
        return h('div', { className: 'tl-root' },
          h('div', { className: 'tl-note' }, t('loading')));
      }

      const dims = cfg.dimensions ?? {};
      const dets = cfg.detectors ?? {};
      const lvls = cfg.levels ?? {};
      const exs = cfg.exemptions ?? {};
      const canEnforce = status?.canEnforce?.ok !== false;
      const setDim = (k, v) => patch({ dimensions: { ...dims, [k]: v } }, { ...cfg, dimensions: { ...dims, [k]: v } });
      const setDet = (k, v) => patch({ detectors: { ...dets, [k]: v } }, { ...cfg, detectors: { ...dets, [k]: v } });
      const setLvl = (k, v) => patch({ levels: { ...lvls, [k]: v } }, { ...cfg, levels: { ...lvls, [k]: v } });
      const setEx = (k, v) => patch({ exemptions: { ...exs, [k]: v } }, { ...cfg, exemptions: { ...exs, [k]: v } });

      const shadow = status?.shadow ?? {};
      const today = status?.today ?? {};

      return h('div', { className: 'tl-root' },
        h('div', { className: 'tl-head' },
          h('h3', { className: 'tl-title' }, t('title')),
          h('p', { className: 'tl-intro' }, t('intro')),
          h('span', { className: 'tl-badge' }, status?.posture ?? cfg.mode ?? '—')),

        h('div', { className: 'tl-stats' },
          h('div', { className: 'tl-stat' },
            h('div', { className: 'tl-stat-k' }, t('today')),
            h('div', { className: 'tl-stat-v' }, fmtTokens(today.tokens ?? today.spent ?? 0))),
          h('div', { className: 'tl-stat' },
            h('div', { className: 'tl-stat-k' }, t('shadow')),
            h('div', { className: 'tl-stat-v' },
              `${shadow.judged ?? 0} ${t('samples')} · ${fmtPct(shadow.falsePositiveRate ?? shadow.rate ?? 0)}`)),
          h('div', { className: 'tl-stat' },
            h('div', { className: 'tl-stat-k' }, t('maxLevel')),
            h('div', { className: 'tl-stat-v' }, String(cfg.maxLevel ?? 'r3').toUpperCase()))),

        // ── 运行姿态 ──
        h(Section, { title: t('secPosture') },
          row('enabled', t('postureEnabled'), null,
            h(Toggle, {
              t, label: t('postureEnabled'), value: cfg.enabled !== false, disabled: busy,
              onChange: (v) => patch({ enabled: v }, { ...cfg, enabled: v }),
            })),
          row('dryRun', t('postureDryRun'), null,
            h(Toggle, {
              t, label: t('postureDryRun'), value: cfg.dryRun !== false, disabled: busy,
              onChange: (v) => patch({ dryRun: v }, { ...cfg, dryRun: v }),
            })),
          row('mode', t('postureMode'), canEnforce ? null : t('locked'),
            h('div', { className: 'tl-seg' }, MODES.map((m) => h('button', {
              key: m,
              type: 'button',
              className: 'tl-seg-b',
              'data-on': cfg.mode === m ? '1' : '0',
              disabled: busy || (m === 'enforce' && !canEnforce),
              onClick: () => patch({ mode: m }, { ...cfg, mode: m }),
            }, t(m === 'observe' ? 'modeObserve' : m === 'advise' ? 'modeAdvise' : 'modeEnforce')))))),

        // ── 七维 ──
        h(Section, { title: t('secDims') },
          DIMS.map(([k, name, desc]) => row(k, `${k} · ${name}`, desc,
            h(Toggle, {
              t, label: k, value: dims[k] !== false, disabled: busy,
              onChange: (v) => setDim(k, v),
            })))),

        // ── 检测器 ──
        h(Section, { title: t('secDetectors') },
          DETECTORS.map(([k, name, desc]) => row(k, `${k} · ${name}`, desc,
            h(Toggle, {
              t, label: k, value: dets[k] !== false, disabled: busy,
              onChange: (v) => setDet(k, v),
            })))),

        // ── 阶梯 ──
        h(Section, { title: t('secLevels') },
          LEVELS.map(([k, name, desc]) => row(k, `${k.toUpperCase()} · ${name}`, desc,
            h(Toggle, {
              t, label: k, value: lvls[k] !== false, disabled: busy,
              onChange: (v) => setLvl(k, v),
            })))),

        // ── 豁免 ──
        h(Section, { title: t('secExempt') },
          EXEMPTS.map(([k, name, desc]) => row(k, `${k.toUpperCase()} · ${name}`, desc,
            h(Toggle, {
              t, label: k, value: exs[k] !== false, disabled: busy,
              onChange: (v) => setEx(k, v),
            })))),

        // ── 数值 ──
        h(Section, { title: t('secNumbers') },
          row('maxLevel', t('maxLevel'), null,
            h('select', {
              className: 'tl-num',
              value: cfg.maxLevel ?? 'r3',
              disabled: busy,
              onChange: (e) => patch({ maxLevel: e.target.value }, { ...cfg, maxLevel: e.target.value }),
            }, LEVELS.map(([k, name]) => h('option', { key: k, value: k }, `${k.toUpperCase()} ${name}`)))),
          row('throttleMs', t('throttle'), null,
            h('input', {
              className: 'tl-num', type: 'number', min: 0, step: 500,
              defaultValue: cfg.throttleMs ?? 3000, disabled: busy,
              onBlur: (e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== cfg.throttleMs) patch({ throttleMs: v }, { ...cfg, throttleMs: v });
              },
            })),
          row('dailyBudget', t('daily'), null,
            h('input', {
              className: 'tl-num', type: 'number', min: 0, step: 100000,
              defaultValue: cfg.dailyBudget ?? 0, disabled: busy,
              onBlur: (e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== cfg.dailyBudget) patch({ dailyBudget: v }, { ...cfg, dailyBudget: v });
              },
            })),
          row('sessionBudget', t('session'), null,
            h('input', {
              className: 'tl-num', type: 'number', min: 0, step: 100000,
              defaultValue: cfg.sessionBudget ?? 0, disabled: busy,
              onBlur: (e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== cfg.sessionBudget) patch({ sessionBudget: v }, { ...cfg, sessionBudget: v });
              },
            }))),

        h('div', { className: 'tl-note' }, t('hint')),
        toast ? h('div', {
          className: 'tl-toast',
          style: toast.kind === 'err' ? { background: 'rgba(220,38,38,.14)' } : undefined,
        }, toast.text) : null);
    }

    /** 1234567 → 1.2M，避免面板上出现一串没法读的数字。 */
    function fmtTokens(n) {
      const v = Number(n) || 0;
      if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(Math.round(v));
    }

    function fmtPct(n) {
      const v = Number(n) || 0;
      return `${(v * 100).toFixed(2)}%`;
    }

    // ── 装配 ──────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-lock: dictionaries');
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'token-lock',
          order: 25,
          label: () => t('nav'),
          locale: NS,
        }, TokenLockSection)),
        'token-lock: settings section',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
