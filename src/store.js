/**
 * store.js — 落盘层
 *
 * 职责：所有对磁盘的写法都收敛在这里，其他模块不直接碰 fs。
 *
 * 三条铁律：
 *   1. 任何 IO 失败都只 console.warn，绝不抛给宿主（插件不能把 DSH 拖崩）。
 *   2. 单文件体积超限就采样，不无限增长（反自噬）。
 *   3. 全部是追加写；只有 baseline.json 做整体覆盖（先写 .tmp 再 rename）。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function createStore(config, log = console) {
  const root = config.dataDir
  let ready = false
  let readyPromise = null
  const sizes = new Map()   // file -> 已写字节数
  const sampled = new Map() // file -> 当前采样分母（1=全记）

  async function ensure() {
    if (ready) return
    if (!readyPromise) {
      readyPromise = fsp.mkdir(root, { recursive: true })
        .then(() => { ready = true })
        .catch((e) => log.warn?.(`[token-lock] 建目录失败 ${root}: ${e.message}`))
    }
    await readyPromise
  }

  function file(name) {
    return path.join(root, name)
  }

  async function sizeOf(name) {
    if (sizes.has(name)) return sizes.get(name)
    try {
      const st = await fsp.stat(file(name))
      sizes.set(name, st.size)
      return st.size
    } catch {
      sizes.set(name, 0)
      return 0
    }
  }

  /**
   * 追加一行 JSON。超限时自动把采样分母乘 10（1 → 10 → 100 …），
   * 被丢弃的行不写，写出时标 sampled 提示下游这是抽样数据。
   */
  async function appendJsonl(name, obj, maxBytes) {
    await ensure()
    const cap = maxBytes ?? config.maxLedgerBytes
    let denom = sampled.get(name) ?? 1

    const cur = await sizeOf(name)
    if (cur > cap && denom < 1000) {
      denom *= 10
      sampled.set(name, denom)
      log.warn?.(`[token-lock] ${name} 超过 ${(cap / 1048576).toFixed(1)}MB，采样降为 1/${denom}`)
    }

    if (denom > 1) {
      // 确定性采样：用 seq/time 做哈希，避免随机导致复现困难
      const key = Number(obj?.seq ?? obj?.ts ?? Date.now())
      if (key % denom !== 0) return false
      obj = { ...obj, sampled: denom }
    }

    const line = JSON.stringify(obj) + '\n'
    try {
      await fsp.appendFile(file(name), line, 'utf8')
      sizes.set(name, cur + Buffer.byteLength(line))
      return true
    } catch (e) {
      log.warn?.(`[token-lock] 追加 ${name} 失败: ${e.message}`)
      return false
    }
  }

  /** 原子覆盖写（先 .tmp 再 rename），用于 baseline.json 这类小状态 */
  async function writeJson(name, obj) {
    await ensure()
    const target = file(name)
    const tmp = target + '.tmp'
    try {
      await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
      await fsp.rename(tmp, target)
      return true
    } catch (e) {
      log.warn?.(`[token-lock] 写 ${name} 失败: ${e.message}`)
      try { await fsp.unlink(tmp) } catch {}
      return false
    }
  }

  async function readJson(name, fallback = null) {
    try {
      const raw = await fsp.readFile(file(name), 'utf8')
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  /** 读全量 jsonl（面板用，只读最近 limit 行） */
  async function readJsonl(name, limit = 2000) {
    try {
      const raw = await fsp.readFile(file(name), 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const slice = lines.length > limit ? lines.slice(-limit) : lines
      const out = []
      for (const l of slice) {
        try { out.push(JSON.parse(l)) } catch {}
      }
      return out
    } catch {
      return []
    }
  }

  function currentSampleRate(name) {
    return 1 / (sampled.get(name) ?? 1)
  }

  function stats() {
    return {
      root,
      ready,
      samples: Object.fromEntries([...sampled].map(([k, v]) => [k, `1/${v}`])),
      sizes: Object.fromEntries(sizes),
    }
  }

  return { ensure, appendJsonl, writeJson, readJson, readJsonl, currentSampleRate, stats, file }
}
