/**
 * 周报整理 —— 后端服务
 *
 * 只用 Node.js 内置模块，不需要 npm install：
 *     node server.js
 *
 * 职责很窄：存取 JSON 文件 + 调 L0 规则层。所有文本处理逻辑都在
 * lib/l0.js 里，这个文件只管 HTTP 和落盘。
 *
 * 存储：data/weeks/<ISO周>.json，一周一个文件。
 * 选它而不是 localStorage —— 跨周对比是核心功能，数据不能跟着浏览器走；
 * 也不用 SQLite —— 每周几百条的量级根本用不上，还会破坏零依赖前提。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const L0 = require('./lib/l0');

const PORT = 3100;                                  // 避开看板的 3000
const DATA_DIR = path.join(__dirname, 'data', 'weeks');
const MAX_BODY = 8 * 1024 * 1024;                   // 8MB，防止一次贴进来一本书

// ═══════════════════════════════════════════════════════════════
// 存储
// ═══════════════════════════════════════════════════════════════

// 周编号直接参与拼路径，必须校验格式，否则 ../../ 就能读到任意文件
const WEEK_RE = /^\d{4}-W\d{2}$/;

function weekFile(week) {
  if (!WEEK_RE.test(week)) throw new HttpError(400, '周编号格式不对，应形如 2026-W31');
  return path.join(DATA_DIR, `${week}.json`);
}

function readWeek(week) {
  const file = weekFile(week);
  if (!fs.existsSync(file)) return { week, sources: [], items: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // 文件坏了就报出来，不要静默返回空数据 —— 否则用户会以为自己的
    // 周报数据凭空消失了，比直接报错更难排查
    throw new HttpError(500, `读取 ${week}.json 失败：${err.message}`);
  }
}

function writeWeek(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = weekFile(state.week);
  // 先写临时文件再改名：写到一半断电也不会留下半个损坏的 JSON
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function listWeeks() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(w => WEEK_RE.test(w))
    .sort()
    .reverse();
}

// ═══════════════════════════════════════════════════════════════
// 视图：state + 派生结果一起返回
//
// 相似候选和概况都是算出来的，不存盘 —— 存了就要考虑何时失效，
// 每次现算反而更简单，几百条数据算一遍不到 1ms。
// ═══════════════════════════════════════════════════════════════

function viewOf(state) {
  const live = state.items.filter(it => !it.mergedInto);
  const similar = L0.findSimilar(live);
  return {
    week: state.week,
    sources: state.sources.map(s => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      author: s.author,
      importedAt: s.importedAt,
      chars: s.raw.length,
      itemCount: live.filter(it => it.sourceId === s.id).length,
    })),
    items: state.items,
    similar,
    summary: L0.summarize(state.items, similar),
    weeks: listWeeks(),
  };
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const routes = {
  // ── 读一周的全部数据 ──
  'GET /api/state'(query) {
    const week = query.week || L0.isoWeek();
    return viewOf(readWeek(week));
  },

  // ── 导入素材 ──
  'POST /api/sources'(query, body) {
    const week = body.week || L0.isoWeek();
    const state = readWeek(week);

    if (!body.raw || !body.raw.trim()) throw new HttpError(400, '素材内容是空的');

    // 换行统一成 \n。原文存的是归一化之后的版本，否则 \r\n 会让
    // 条目的字符区间偏移一位，回溯原文时高亮的位置就错了
    const raw = String(body.raw).replace(/\r\n?/g, '\n');
    const kind = body.kind === 'file' ? 'file' : 'paste';

    const source = {
      id: L0.newId('s'),
      kind,
      name: (body.name || '粘贴内容').slice(0, 120),
      author: (body.author || '').slice(0, 40),
      importedAt: new Date().toISOString(),
      // CSV 先转成等价的行文本，让两条导入路径共用同一套切分规则
      raw: /\.csv$/i.test(body.name || '') ? L0.csvToText(raw) : raw,
    };

    if (!source.raw.trim()) throw new HttpError(400, 'CSV 解析后没有内容，检查一下文件格式');

    const items = L0.buildItems(source, week);

    state.week = week;
    state.sources.push(source);
    state.items.push(...items);
    writeWeek(state);

    return viewOf(state);
  },

  // ── 删除素材：连同它派生出的条目一起删 ──
  'DELETE /api/sources'(query, body) {
    const week = body.week || L0.isoWeek();
    const state = readWeek(week);

    const before = state.sources.length;
    state.sources = state.sources.filter(s => s.id !== body.id);
    if (state.sources.length === before) throw new HttpError(404, '找不到这份素材');

    state.items = state.items.filter(it => it.sourceId !== body.id);
    writeWeek(state);
    return viewOf(state);
  },

  // ── 改条目 ──
  'PATCH /api/items'(query, body) {
    const week = body.week || L0.isoWeek();
    const state = readWeek(week);

    const item = state.items.find(it => it.id === body.id);
    if (!item) throw new HttpError(404, '找不到这条');

    // 白名单，避免前端一不小心把 range / sourceId 覆盖掉，
    // 那样就再也回溯不到原文了
    const EDITABLE = ['owner', 'project', 'category', 'text', 'status', 'reviewed'];
    for (const k of EDITABLE) {
      if (body.patch && k in body.patch) item[k] = body.patch[k];
    }

    // 正文改了就重算数字。类别/状态是人手动改的，不覆盖人的判断
    if (body.patch && 'text' in body.patch) {
      item.metrics = L0.extractMetrics(item.text);
    }
    // 人碰过的条目一律满置信度 —— 置信度表达的是「机器有多确定」，
    // 人确认过之后这个数就没意义了
    if (body.patch && body.patch.reviewed) item.confidence = 1;

    writeWeek(state);
    return viewOf(state);
  },

  // ── 合并：把若干条并进一条 ──
  //
  // 不真删。被合并的条目打上 mergedInto 标记后从列表里隐藏，
  // 随时可以撤销。原始素材更是一个字都不动。
  'POST /api/items/merge'(query, body) {
    const week = body.week || L0.isoWeek();
    const state = readWeek(week);

    const { targetId, sourceIds } = body;
    const target = state.items.find(it => it.id === targetId);
    if (!target) throw new HttpError(404, '找不到合并目标');
    if (!Array.isArray(sourceIds) || !sourceIds.length) throw new HttpError(400, '没有选中要合并的条目');

    for (const id of sourceIds) {
      if (id === targetId) continue;
      const src = state.items.find(it => it.id === id);
      if (!src || src.mergedInto) continue;
      src.mergedInto = targetId;
      target.mergedFrom.push(id);
    }

    // 合并后补全信息：目标条目缺的字段，从被合并的条目里捡
    for (const id of target.mergedFrom) {
      const src = state.items.find(it => it.id === id);
      if (!src) continue;
      if (!target.owner && src.owner) target.owner = src.owner;
      if (!target.project && src.project) target.project = src.project;
      if (!target.metrics.length && src.metrics.length) target.metrics = src.metrics;
    }
    target.reviewed = true;
    target.confidence = 1;

    writeWeek(state);
    return viewOf(state);
  },

  // ── 撤销合并 ──
  'POST /api/items/unmerge'(query, body) {
    const week = body.week || L0.isoWeek();
    const state = readWeek(week);

    const target = state.items.find(it => it.id === body.id);
    if (!target) throw new HttpError(404, '找不到这条');

    for (const id of target.mergedFrom) {
      const src = state.items.find(it => it.id === id);
      if (src) delete src.mergedInto;
    }
    target.mergedFrom = [];

    writeWeek(state);
    return viewOf(state);
  },

  // ── 取原文（回溯用）──
  'GET /api/source'(query) {
    const state = readWeek(query.week || L0.isoWeek());
    const src = state.sources.find(s => s.id === query.id);
    if (!src) throw new HttpError(404, '找不到这份素材');
    return { id: src.id, name: src.name, raw: src.raw };
  },
};

// ═══════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '内容太大了（上限 8MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch { reject(new HttpError(400, '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${key}`);

  // ── 页面 ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 找不到 index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── 接口 ──
  const handler = routes[key];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  try {
    const query = Object.fromEntries(url.searchParams);
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = handler(query, body);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('  ↳ 出错:', err);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || '服务器错误' }));
  }
});

server.listen(PORT, () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('─'.repeat(52));
  console.log('  周报整理已启动');
  console.log(`  页面：    http://localhost:${PORT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  当前周：  ${L0.isoWeek()}`);
  console.log('  按 Ctrl+C 停止');
  console.log('─'.repeat(52));
});
