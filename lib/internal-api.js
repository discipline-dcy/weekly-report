/**
 * 内部接口客户端
 *
 * 两个用途，各自收敛成**一个替换点**——跟看板项目里
 * 「替换 readProduction() 一个函数即可接入真实数据源」是同一个思路：
 *
 *   1. pullReports()  从内网拉各人提交的周报
 *   2. callL1()       调内网大模型做语义分析
 *
 * 拿到真实接口后，只需要改每个函数里标了「★ 替换点」的那一段，
 * 其余代码（超时、降级、错误处理、上层调用）一律不用动。
 *
 * ── 认证 ──
 * 当前明确不带认证（内网接口直连）。authHeaders() 是预留的空实现，
 * 以后要加 token 或 OA 单点登录，只改那一个函数，调用方感知不到。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

let cache = null;

function config() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    // 配置文件缺失或写坏了不能让整个服务起不来 —— L0 规则层本来就该
    // 在没有任何外部依赖时独立可用，这是分层设计的全部意义
    console.warn(`[内部接口] 读不到 config.json（${err.message}），两个接口都按未启用处理`);
    cache = { reports: { enabled: false }, l1: { enabled: false } };
  }
  return cache;
}

function status() {
  const c = config();
  return {
    reports: { enabled: !!c.reports?.enabled, url: c.reports?.url || '' },
    l1: { enabled: !!c.l1?.enabled, url: c.l1?.url || '' },
  };
}

/**
 * ★ 认证预留位。
 *
 * 现在返回空对象 = 不带认证，这是当前的明确决定。
 * 以后要加，只改这里：读环境变量里的 token、或换 OA 的票据，
 * 上面两个函数和 server.js 都不用动。
 */
function authHeaders() {
  return {};
}

// ═══════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════

class ApiError extends Error {}

async function request(url, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // 内网不通、DNS 解析不了、超时，都收敛成一句人话
    const why = err.name === 'TimeoutError' ? `超过 ${timeoutMs}ms 没响应` : err.message;
    throw new ApiError(`连不上 ${url}（${why}）`);
  }

  const text = await res.text();
  if (!res.ok) throw new ApiError(`${url} 返回 ${res.status}：${text.slice(0, 200)}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`${url} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. 拉周报
// ═══════════════════════════════════════════════════════════════

/**
 * 从内网接口拉某一周的周报。
 *
 * @returns {Promise<Array<{author, name, raw}>>} 与手工导入完全相同的形状，
 *          交给同一套 L0 切分逻辑处理 —— 两条导入路径共用规则，
 *          不会出现「拉下来的和粘贴的分得不一样」
 */
async function pullReports(week) {
  const c = config().reports;
  if (!c?.enabled) throw new ApiError('周报拉取接口未启用，先在 config.json 里把 reports.enabled 改成 true');
  if (!c.url || c.url.includes('内网地址')) throw new ApiError('还没填 config.json 里的 reports.url');

  const raw = await request(`${c.url}?week=${encodeURIComponent(week)}`, {
    timeoutMs: c.timeoutMs || 10000,
  });

  // ★ 替换点 1／2 ──────────────────────────────────────────────
  // 下面这段把内网接口的返回值映射成本项目的形状。
  // 拿到真实接口文档后，只改这个 normalize 函数。
  //
  // 当前假设返回形如：
  //   { data: [ { name/author/user/submitter, content/text/body/raw, ... } ] }
  // 尽量多认几种常见字段名，减少对接时的来回。
  return normalizeReports(raw);
  // ────────────────────────────────────────────────────────────
}

function normalizeReports(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.list) ? raw.list
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.result) ? raw.result
    : null;

  if (!rows) {
    throw new ApiError('接口返回里找不到数组（试过 data / list / items / result），需要按真实格式调整 normalizeReports()');
  }

  const pick = (o, keys) => {
    for (const k of keys) {
      if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim();
    }
    return '';
  };

  return rows.map((r, i) => {
    const author = pick(r, ['author', 'name', 'userName', 'user_name', 'submitter', 'employeeName', 'realName']);
    const raw = pick(r, ['raw', 'content', 'text', 'body', 'detail', 'workContent', 'summary']);
    return {
      author,
      name: author ? `${author}（接口）` : `接口记录 ${i + 1}`,
      raw,
    };
  }).filter(r => r.raw);
}

// ═══════════════════════════════════════════════════════════════
// 2. L1 语义层
// ═══════════════════════════════════════════════════════════════

/**
 * 让内网模型做两件 L0 规则层做不了的事：
 *   · 归类：正文没有明显关键词时判断类别和状态
 *   · 同义判定：「完成了看板原型」和「把大屏页面搭起来了」是不是一回事
 *
 * 注意这里**只返回建议，不直接改数据**。合并与否由人在页面上点，
 * 这是设计原则第一条 —— 误合并丢掉的信息，用户根本不知道自己丢了什么。
 *
 * @returns {Promise<{classify: Array, pairs: Array}>}
 */
async function callL1(items) {
  const c = config().l1;
  if (!c?.enabled) throw new ApiError('L1 语义层未启用，先在 config.json 里把 l1.enabled 改成 true');
  if (!c.url || c.url.includes('内网地址')) throw new ApiError('还没填 config.json 里的 l1.url');

  const payload = buildPrompt(items);

  // ★ 替换点 2／2 ──────────────────────────────────────────────
  // 内网模型网关的请求/响应格式各家不同，这里按最常见的
  // OpenAI 兼容格式写。拿到真实网关文档后只改这一段。
  const res = await request(c.url, {
    method: 'POST',
    timeoutMs: c.timeoutMs || 30000,
    body: {
      model: c.model || undefined,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payload },
      ],
      temperature: 0,
      stream: false,
    },
  });

  const content =
    res?.choices?.[0]?.message?.content ??   // OpenAI 兼容
    res?.data?.content ??
    res?.content ??
    res?.result ??
    res?.output;

  if (typeof content !== 'string') {
    throw new ApiError('模型返回里找不到文本内容，需要按真实网关格式调整 callL1()');
  }
  // ────────────────────────────────────────────────────────────

  return parseL1(content, items);
}

const SYSTEM_PROMPT = `你在帮人整理周报。会给你一组条目，每条有编号和正文。

做两件事，用 JSON 回答，不要任何解释文字：

1. classify：对每条判断类别和状态。
   类别取值：进展 / 问题 / 计划 / 风险 / 数据
   状态取值：已完成 / 进行中 / 阻塞 / 未开始
2. pairs：找出说的是同一件事的条目对。只找真正同一件事的，
   仅仅是同一个项目、同一个人不算。宁可少给也不要多给。

格式：
{"classify":[{"i":1,"category":"进展","status":"已完成"}],
 "pairs":[{"a":1,"b":5,"why":"都在说看板原型完成"}]}`;

function buildPrompt(items) {
  return items.map((it, i) => `${i + 1}. ${it.text}`).join('\n');
}

/**
 * 解析模型回答。模型可能裹一层 ```json 代码块，也可能前后带废话，
 * 所以取第一个 { 到最后一个 } 之间的内容再解析。
 */
function parseL1(content, items) {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ApiError('模型没返回 JSON');

  let data;
  try {
    data = JSON.parse(content.slice(start, end + 1));
  } catch (err) {
    throw new ApiError(`模型返回的 JSON 解析失败：${err.message}`);
  }

  const CATEGORIES = new Set(['进展', '问题', '计划', '风险', '数据']);
  const STATUSES = new Set(['已完成', '进行中', '阻塞', '未开始']);
  const at = n => items[Number(n) - 1];   // 提示词里用 1 开始的编号，更不容易让模型算错

  const classify = [];
  for (const c of data.classify || []) {
    const item = at(c.i);
    if (!item) continue;
    classify.push({
      id: item.id,
      category: CATEGORIES.has(c.category) ? c.category : null,
      status: STATUSES.has(c.status) ? c.status : null,
    });
  }

  const pairs = [];
  for (const p of data.pairs || []) {
    const a = at(p.a), b = at(p.b);
    if (!a || !b || a.id === b.id) continue;
    pairs.push({ a: a.id, b: b.id, why: String(p.why || '').slice(0, 120) });
  }

  return { classify, pairs };
}

module.exports = { config, status, pullReports, callL1, ApiError, normalizeReports, parseL1 };
