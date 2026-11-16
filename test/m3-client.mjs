// m3-client.mjs — 客户端半边（lib/client.js）的装载契约测试
//
// lib/client.js 是浏览器模块：它把自己交给 window.__ModuleLoader__，
// 由宿主在浏览器里用 require('react') 之类把依赖注进来。
// 这里在 Node 里搭一个最小宿主外壳，验证：
//   1. 模块交给 loader 时 id 正确、factory 是函数
//   2. exports 面是 { apply, inject }，inject 声明了 slots / locale
//   3. apply() 里真的注册了 locale 字典与 settings.section（id / order 正确）
//   4. 分组开关的数量与后端 DETECTORS / DIMENSIONS / LEVELS / EXEMPTIONS 对齐
//
// 不渲染组件（那要整套 React 运行时），只验注册契约 —— 装载失败的原因
// 九成出在这一层，而不是出在 JSX 树上。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { DETECTORS, DIMENSIONS, LEVELS, EXEMPTIONS } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'client.js');

/** 最小 React 桩：够 apply() 与顶层表构造用，不渲染。 */
function reactStub() {
  const el = (type, props, ...children) => ({ type, props, children });
  return {
    createElement: el,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (f) => f(),
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
    Fragment: Symbol.for('react.fragment'),
  };
}

/** 在隔离 vm 里跑 client.js，返回 loader 收到的注册信息。 */
function loadClient() {
  const seen = { load: null, module: null };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ json: async () => ({}) }),
    window: {
      __ModuleLoader__: {
        load(spec) {
          seen.load = { id: spec.id, hasFactory: typeof spec.factory === 'function' };
          const req = (name) => {
            if (name === 'react') return reactStub();
            throw new Error('unexpected require: ' + name);
          };
          seen.module = spec.factory(req);
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  runInContext(readFileSync(CLIENT, 'utf8'), createContext(sandbox), { filename: 'client.js' });
  return seen;
}

test('client.js 把自己交给 __ModuleLoader__，id 与包名一致', () => {
  const seen = loadClient();
  assert.ok(seen.load, '没有调用 window.__ModuleLoader__.load');
  assert.equal(seen.load.id, 'dsh-token-lock');
  assert.ok(seen.load.hasFactory, 'factory 不是函数');
});

test('exports 面是 apply / inject，inject 声明 slots 与 locale', () => {
  const { module: mod } = loadClient();
  assert.equal(typeof mod.apply, 'function', 'apply 缺失');
  assert.ok(Array.isArray(mod.inject), 'inject 不是数组');
  assert.deepEqual([...mod.inject].sort(), ['locale', 'slots']);
});

test('apply() 注册 locale 字典（token-lock / zh + en）与 settings.section', () => {
  const { module: mod } = loadClient();

  const dicts = [];
  const sections = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: (ns) => (k) => `${ns}:${k}`,
      register: (ns, table) => {
        dicts.push({ ns, table });
        return () => {};
      },
    },
    slots: {
      // 真实契约（见 dsh-client-ui-settings-plugins/lib/client.js:263）：
      //   ctx.slots.inject("settings.section", () => ctx.slots.register(opts, Component))
      // 即 inject 收一个 thunk，等该 slot 被声明后再执行；register 仍在外层 ctx 上。
      inject: (name, factory) => {
        factory();
        return () => {};
      },
      register: (opts, component) => {
        sections.push({ name: opts.name, id: opts.id, order: opts.order, component });
        return () => {};
      },
    },
    effect: (fn, label) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return () => {};
    },
  };

  mod.apply(ctx);

  // locale 字典
  const dict = dicts.find((d) => d.ns === 'token-lock');
  assert.ok(dict, '没有注册 token-lock 的字典');
  for (const lang of ['zh', 'en']) {
    assert.ok(dict.table[lang], `字典缺 ${lang}`);
    assert.ok(dict.table[lang].nav, `字典 ${lang} 缺 nav`);
  }

  // settings.section
  assert.equal(sections.length, 1, '应当只注册一个 settings.section');
  const sec = sections[0];
  assert.equal(sec.name, 'settings.section');
  assert.equal(sec.id, 'token-lock');
  assert.equal(sec.order, 25, 'order 必须是 25（排在 agent-presets 的 20 之后）');
  assert.equal(typeof sec.component, 'function', 'component 不是函数');

  // effect 的清理句柄都拿到手了（卸载时不残留注册）
  assert.equal(effects.length, 2, '应当有两个 effect（字典 + 分区）');
  for (const e of effects) assert.equal(typeof e.dispose, 'function');
});

test('界面开关数量与后端定义一一对应（不再硬编码两份）', () => {
  const src = readFileSync(CLIENT, 'utf8');
  // 静态表是 [key, 名称, 说明] 的元组数组；数条目数是否与后端常量一致。
  const countIn = (varName) => {
    const m = src.match(new RegExp(`const ${varName} = \\[([\\s\\S]*?)\\n\\s*\\];`));
    assert.ok(m, `找不到 ${varName} 表`);
    return (m[1].match(/^\s*\['/gm) ?? []).length;
  };
  assert.equal(countIn('DIMS'), DIMENSIONS.length, '七维数量不一致');
  assert.equal(countIn('DETECTORS'), DETECTORS.length, '检测器数量不一致');
  assert.equal(countIn('LEVELS'), LEVELS.length, '阶梯数量不一致');
  assert.equal(countIn('EXEMPTS'), EXEMPTIONS.length, '豁免数量不一致');
});
