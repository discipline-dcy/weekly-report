/**
 * L0 规则层 —— 不依赖任何外部服务的文本处理
 *
 * 这一层的全部意义在于：**没有网络、没有 API Key、内容不许出内网时，
 * 页面依然能用**。所有函数都是纯函数，输入什么输出什么，方便单独测。
 *
 * 五件事：
 *   1. splitEntries()   把一坨文本拆成一条条独立事项
 *   2. classify()       猜类别（进展/问题/计划/风险/数据）
 *   3. detectStatus()   猜状态（已完成/进行中/阻塞/未开始）
 *   4. extractMetrics() 抽出数字和单位
 *   5. findSimilar()    找出可能重复的条目
 *
 * 猜错是正常的。所以每条都带 confidence，界面上低置信度会标黄让人复核，
 * 而不是假装自己猜得很准。
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// 词表
//
// 顺序有讲究：越靠前的越优先命中。比如「完成了但被阻塞」这种句子，
// 阻塞是更需要被看见的信号，所以阻塞排在已完成前面。
// ═══════════════════════════════════════════════════════════════

const CATEGORY_RULES = [
  { name: '风险', words: ['风险', '隐患', '担心', '不确定', '恐怕', '可能会', '存在风险'] },
  { name: '问题', words: ['问题', '故障', '报错', '异常', '失败', '不稳定', '缺陷', 'bug', 'BUG', 'Bug', '排查', '阻塞', '卡在', '卡住', '卡着', '没确认', '未确认', '没定'] },
  { name: '计划', words: ['下周', '下阶段', '计划', '准备', '打算', '拟', '后续', '接下来', '预计'] },
  { name: '进展', words: ['完成', '已', '上线', '交付', '发布', '修复', '实现', '跑通', '搭建', '输出', '提交', '推进', '优化', '整理', '对接', '评审'] },
  { name: '数据', words: ['统计', '数据', '占比', '同比', '环比', '累计', '合计'] },
];

const STATUS_RULES = [
  // 「待确认」故意不收：它太常出现在文档名和清单名里（「待确认问题清单」），
  // 一收就会把「写了 3 份文档」判成阻塞。这个工具里**误报比漏报危险** ——
  // 漏标一个阻塞只是少个提示，误标一个会带着 ⚠ 直接进草稿发出去。
  // 宁可靠「没确认/未确认」这类带明确否定的词，precision 优先。
  { name: '阻塞',   words: ['阻塞', '卡在', '卡住', '卡着', '被卡', '延期', '无法', '没确认', '未确认', '没定', '搁置', '等待', '在等', '还在等', '需要配合', '需协调', '暂停'] },
  { name: '已完成', words: ['已完成', '完成了', '已上线', '已交付', '已发布', '已修复', '跑通', '结束', '完成'] },
  { name: '未开始', words: ['未开始', '尚未', '还没', '待启动', '下周开始'] },
  { name: '进行中', words: ['进行中', '正在', '持续', '继续', '在做', '推进中', '开发中'] },
];

// 归一化时丢掉的虚词。只丢真正不携带信息的，「完成」「上线」这种一律保留
const STOPWORDS = [
  '的', '了', '着', '和', '与', '及', '以及', '并', '而', '就', '把', '被',
  '在', '于', '对', '为', '是', '有', '个', '也', '还', '都', '很', '已经',
  '进行', '相关', '方面', '工作', '情况', '一下', '一些', '目前', '现在',
  '这个', '那个', '本周', '上周', '下周', '今天', '昨天',
];

// 判断行首「张三：」这类署名时，要排掉的常见小标题。
//
// 用「包含」而不是「相等」来判断 —— 「下周计划：对接数据源」里的
// 「下周计划」是四个字，长度上完全像个人名，只有包含匹配才能挡住。
const NOT_A_NAME = [
  '问题', '进展', '计划', '风险', '数据', '备注', '说明', '结论', '其他',
  '本周', '下周', '上周', '情况', '总结', '摘要', '概述', '目标', '状态',
  '内容', '事项', '任务', '项目', '负责', '完成', '待办', '阻塞', '需求',
];

function looksLikeName(s) {
  return !NOT_A_NAME.some(w => s.includes(w));
}

// 这些词当标题时表示「分类」，不是项目名。
// 「问题：」下面挂的条目，项目应该继承上一个真正的标题，而不是变成「问题」
const CATEGORY_LABELS = {
  '进展': '进展', '本周进展': '进展', '完成事项': '进展', '本周工作': '进展',
  '问题': '问题', '问题与阻塞': '问题', '遇到的问题': '问题', '阻塞': '问题',
  '计划': '计划', '下周计划': '计划', '后续计划': '计划', '待办': '计划',
  '风险': '风险', '风险项': '风险',
  '数据': '数据', '关键数据': '数据',
  // 这些是没信息量的段落标题，收进来是为了不让它们变成项目名
  '本周做的事情': '进展', '本周工作内容': '进展', '工作内容': '进展', '本周小结': '进展',
};

// 行内前后缀：CSV 转出来的行长这样 —— 王五：【周报工具】完成了 X（已完成）
const INLINE_PROJECT = /^[【\[]\s*([^】\]]{1,24})\s*[】\]]\s*/;
const INLINE_STATUS = /[（(]\s*(已完成|完成|进行中|进行|阻塞|未开始|待开始|待办)\s*[)）]\s*$/;
const STATUS_ALIAS = { '完成': '已完成', '进行': '进行中', '待开始': '未开始', '待办': '未开始' };

// ═══════════════════════════════════════════════════════════════
// 1. 切分：把一坨文本拆成一条条事项
// ═══════════════════════════════════════════════════════════════

const BULLET = /^\s*(?:[-*•·▪◦–—]|\d+\s*[.、)）]|[(（]\s*\d+\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;
const HEADING_MD = /^\s*#{1,6}\s*(.+?)\s*$/;
const HEADING_BRACKET = /^\s*[【\[]\s*(.+?)\s*[】\]]\s*[:：]?\s*$/;
const HEADING_CN = /^\s*(?:[一二三四五六七八九十]+)\s*[、.]\s*(.+?)\s*$/;
const OWNER_PREFIX = /^([一-龥]{2,4}|[A-Za-z][A-Za-z.\s]{1,18})\s*[:：]\s*(.+)$/;

/**
 * 把原文拆成条目，并记录每条在原文里的字符区间。
 *
 * 区间（range）是整个页面可信度的地基 —— 用户能点回原文验证「这条是从
 * 哪句话抽出来的」，才会信任后面的分析结论。所以偏移量必须准确，
 * 原文在存储前统一换行符，避免 \r\n 让偏移错位。
 *
 * @param {string} raw 已归一化换行的原文
 * @returns {Array<{text, range, project, rawLine}>}
 */
function splitEntries(raw) {
  const entries = [];
  const lines = raw.split('\n');

  let offset = 0;
  let project = null;        // 最近一个「真·标题」，作为项目名的兜底
  let categoryHint = null;   // 最近一个分类小标题，如「问题：」

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;   // +1 是被 split 吃掉的那个换行符

    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── 标题行：只更新上下文，本身不成为条目 ──
    const heading = matchHeading(trimmed);
    if (heading !== null) {
      const label = CATEGORY_LABELS[heading.trim()];
      if (label) categoryHint = label;   // 分类标题：不覆盖项目名
      else { project = heading; categoryHint = null; }
      continue;
    }

    // ── 正文行 ──
    // 先算出去掉项目符号后，正文在这一行里的起始位置
    const leading = line.length - line.trimStart().length;
    const bulletMatch = line.slice(leading).match(BULLET);
    const bulletLen = bulletMatch ? bulletMatch[0].length : 0;

    let bodyStart = lineStart + leading + bulletLen;
    let text = line.slice(leading + bulletLen).trim();
    if (!text) continue;

    // 行首「XX：」可能是署名，也可能是分类标签，得分开处理
    let owner = null;
    let lineHint = null;
    const om = text.match(OWNER_PREFIX);
    if (om) {
      const head = om[1].trim();
      const label = CATEGORY_LABELS[head];
      if (label) {
        // 「下周计划：对接数据源」→ 类别取计划，正文只留「对接数据源」
        lineHint = label;
        bodyStart += text.length - om[2].length;
        text = om[2].trim();
      } else if (looksLikeName(head)) {
        owner = head;
        bodyStart += text.length - om[2].length;
        text = om[2].trim();
      }
      // 两者都不像就原样保留，不乱猜
    }

    // 行内【项目】前缀。CSV 转出来的行必然带这个，手写的也常见。
    // 之前只认「整行都是【xx】」的标题写法，导致 CSV 导入的项目名
    // 全留在正文里，project 字段反而是空的。
    let inlineProject = null;
    const pm = text.match(INLINE_PROJECT);
    if (pm) {
      inlineProject = pm[1].trim();
      bodyStart += pm[0].length;
      text = text.slice(pm[0].length);
    }

    // 行尾（状态）后缀，同样来自 CSV
    let statusHint = null;
    const sm = text.match(INLINE_STATUS);
    if (sm) {
      const raw = sm[1];
      statusHint = STATUS_ALIAS[raw] || raw;
      text = text.slice(0, text.length - sm[0].length).trim();
    }

    // 太短的行基本是噪声（分隔线、单个字），丢掉
    if (text.replace(/[^一-龥A-Za-z0-9]/g, '').length < 3) continue;

    entries.push({
      text,
      owner,
      project: inlineProject || project,   // 行内【项目】比段落标题更贴近这一条
      statusHint,
      // 两种标签强度不同，不能混成一个字段：
      //   lineLabel    「下周计划：对接数据源」—— 对这一条的明确声明，最可信
      //   sectionLabel 「问题：」下面的一组 —— 只是分组，组里混进一条风险很正常
      lineLabel: lineHint,
      sectionLabel: categoryHint,
      range: [bodyStart, bodyStart + text.length],
    });
  }

  return entries;
}

function matchHeading(trimmed) {
  let m = trimmed.match(HEADING_MD);
  if (m) return m[1];

  m = trimmed.match(HEADING_BRACKET);
  if (m) return m[1];

  m = trimmed.match(HEADING_CN);
  if (m && m[1].length <= 20 && !/[，。；]/.test(m[1])) return m[1];

  // 短且以冒号结尾、后面没内容 —— 典型的小标题写法
  if (/[:：]\s*$/.test(trimmed) && trimmed.length <= 22) {
    return trimmed.replace(/[:：]\s*$/, '').trim();
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// 2/3. 类别与状态
// ═══════════════════════════════════════════════════════════════

function classify(text) {
  for (const rule of CATEGORY_RULES) {
    for (const w of rule.words) {
      if (text.includes(w)) return { value: rule.name, hit: w };
    }
  }
  return { value: '进展', hit: null };   // 兜底：周报里最常见的就是进展
}

function detectStatus(text, category) {
  for (const rule of STATUS_RULES) {
    for (const w of rule.words) {
      if (text.includes(w)) return { value: rule.name, hit: w };
    }
  }
  return { value: category === '计划' ? '未开始' : '进行中', hit: null };
}

// ═══════════════════════════════════════════════════════════════
// 4. 抽数字
//
// 「无量化条目占比」这个指标全靠它。难点是别把日期、版本号当成量化结果
// —— "7 月 28 日完成联调" 里的 7 和 28 都不是成果。
// ═══════════════════════════════════════════════════════════════

const DATE_LIKE = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}[-/月]\d{1,2}日?|\d{4}\s*-?\s*[Ww]\d{1,2}|v?\d+\.\d+(\.\d+)?|\d{1,2}\s*[:：]\s*\d{2}/g;
const UNITS = '%|％|个|条|项|次|人|天|小时|分钟|台|套|份|页|张|周|月|款|家|万|千|元|万元|倍|k|K|MB|GB';
const METRIC = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, 'g');

function extractMetrics(text) {
  // 先把日期/版本号用等长占位符盖掉，避免它们被当成量化结果
  const masked = text.replace(DATE_LIKE, m => ' '.repeat(m.length));

  const out = [];
  let m;
  METRIC.lastIndex = 0;
  while ((m = METRIC.exec(masked)) !== null) {
    out.push({ value: Number(m[1]), unit: m[2] });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 5. 相似度：字符 3-gram 的 Jaccard
//
// 为什么用这个而不是更聪明的算法：它可解释。界面上能直接告诉用户
// 「这两条 88% 像」，用户自己能看懂为什么。语义级别的同义判断
// （"完成看板原型" vs "把大屏页面搭起来了"）规则层抓不住，那是 L1 的事。
// ═══════════════════════════════════════════════════════════════

function normalize(text) {
  let s = text.toLowerCase();
  s = s.replace(/[\s\p{P}\p{S}]/gu, '');          // 去空白、标点、符号
  for (const w of STOPWORDS) s = s.split(w).join('');
  return s;
}

function trigrams(s) {
  const set = new Set();
  if (s.length <= 3) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 相似度 = 3-gram 相似度 与 字集相似度 各占一半。
 *
 * 只用 3-gram 会漏掉语序调换的重复：「完成看板原型，接口跑通」和
 * 「看板原型完成，接口跑通了」是同一件事，但 3-gram 只有 0.33 —— 因为
 * 挪动位置把绝大多数三字窗口都打散了。字集相似度对语序不敏感，正好补上
 * 这个洞；反过来单用字集又会把「完成A项目」和「完成B项目」判成一样，
 * 所以两者各取一半，谁也不能单独说了算。
 */
function similarity(textA, textB) {
  const a = normalize(textA);
  const b = normalize(textB);
  const setA = new Set(a);
  const setB = new Set(b);

  const gram = jaccard(trigrams(a), trigrams(b));
  const chars = jaccard(setA, setB);
  const blended = gram * 0.5 + chars * 0.5;

  // 包含关系单独算一遍。
  //
  // 周报里最常见的重复形态不是「两句话差不多」，而是**一个人写详版、
  // 另一个人写简版**：「完成看板原型，前后端接口跑通，覆盖 6 条产线」
  // 和「看板原型已经完成，接口也跑通了」。简版的字几乎全在详版里，
  // 但长度差一倍，Jaccard 会被分母拖到 0.36，直接漏掉。
  //
  // 两道闸门防止误报：
  //   · 两条都得够长（短句之间字符重合纯属巧合）
  //   · 封顶 0.82，卡在 strong 阈值(0.85)以下 —— 包含不等于等价，
  //     这类只能进「可能重复」的折叠区，不许直接跳到人脸上
  let contain = 0;
  if (Math.min(a.length, b.length) >= 8) {
    let inter = 0;
    for (const c of setB) if (setA.has(c)) inter++;
    contain = inter / Math.min(setA.size, setB.size) * 0.82;
  }

  return Math.max(blended, contain);
}

const STRONG = 0.85;
const WEAK = 0.60;

/**
 * 找出可能重复的条目对。
 *
 * 只返回候选，绝不自动合并 —— 误合并丢掉的信息，用户根本不知道
 * 自己丢了什么。合并动作必须由人点，且可撤销。
 */
function findSimilar(items) {
  const pairs = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = similarity(items[i].text, items[j].text);
      if (score < WEAK) continue;
      pairs.push({
        a: items[i].id,
        b: items[j].id,
        score: +score.toFixed(3),
        level: score >= STRONG ? 'strong' : 'weak',
      });
    }
  }

  return pairs.sort((x, y) => y.score - x.score);
}

// ═══════════════════════════════════════════════════════════════
// 组装：原文 → 条目
// ═══════════════════════════════════════════════════════════════

/**
 * 置信度 = 有多少证据支持这次自动判断。
 * 没命中任何关键词、也没抽到数字的条目分最低，界面上标黄提示复核。
 */
function scoreConfidence({ categoryHit, statusHit, metrics, hasOwner, hasProject, agreed }) {
  let s = 0.35;
  if (categoryHit) s += 0.22;
  if (statusHit) s += 0.18;
  if (metrics.length) s += 0.15;
  if (hasOwner) s += 0.05;
  if (hasProject) s += 0.05;
  if (agreed) s += 0.08;          // 正文关键词和标题分组对上了，更可信
  return Math.min(1, +s.toFixed(2));
}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * 把一份素材转成条目数组。
 * @param {{id, author, raw}} source
 * @param {string} week
 */
function buildItems(source, week) {
  return splitEntries(source.raw).map(e => {
    const guess = classify(e.text);

    // 三个信号按可信度排序：
    //   1. 行内标签 —— 用户对这一条的明确声明，压过一切
    //   2. 正文关键词
    //   3. 段落标题 —— 只在正文什么都没命中时兜底
    //
    // 第 2 条压过第 3 条是有意的：写在「问题：」下面的「存在白屏风险」，
    // 判成风险比判成问题更准。但第 1 条必须压过第 2 条，否则
    // 「下周计划：对接数据源」会被里面的「对接」带偏成进展。
    let category;
    if (e.lineLabel)      category = { value: e.lineLabel, hit: 'label' };
    else if (guess.hit)   category = guess;
    else if (e.sectionLabel) category = { value: e.sectionLabel, hit: 'heading' };
    else                  category = guess;

    const agreed = !!(guess.hit && guess.value === category.value && category.hit !== guess.hit);

    // 表格里明确填了状态，就用它 —— 那是人填的，比关键词猜的准
    const status = e.statusHint
      ? { value: e.statusHint, hit: 'column' }
      : detectStatus(e.text, category.value);

    // 「协助排查了刷新闪烁的问题」「修复了登录失败」—— 这些含问题类关键词，
    // 但说的是**把问题解决了**，属于进展。已完成 + 问题类基本都是这种情况。
    if (category.value === '问题' && status.value === '已完成') {
      category = { value: '进展', hit: category.hit };
    }
    const metrics = extractMetrics(e.text);
    const owner = e.owner || source.author || '';
    const project = e.project || '';

    return {
      id: newId('i'),
      sourceId: source.id,
      range: e.range,
      week,
      owner,
      project,
      category: category.value,
      text: e.text,
      metrics,
      status: status.value,
      linkedPrev: null,
      mergedFrom: [],
      confidence: scoreConfidence({
        categoryHit: category.hit,
        statusHit: status.hit,
        metrics,
        hasOwner: !!owner,
        hasProject: !!project,
        agreed,
      }),
      reviewed: false,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// CSV
//
// 一期不支持 .xlsx —— 零依赖前提下手写 xlsx 解析不现实（本质是
// zip + 一堆 XML）。让用户另存为 CSV，多一步操作换零风险。
// ═══════════════════════════════════════════════════════════════

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(cell => cell.trim()));
}

const COLUMN_HINTS = {
  owner:    ['姓名', '人员', '负责人', '责任人', '提交人', '成员', 'owner', 'name'],
  project:  ['项目', '模块', '产品', '系统', 'project'],
  text:     ['内容', '事项', '工作', '描述', '进展', '任务', '说明', 'content', 'item'],
  category: ['类别', '分类', '类型', 'category'],
  status:   ['状态', '进度', 'status'],
};

/**
 * CSV → 与纯文本等价的行文本，交给同一套 splitEntries 处理。
 * 这样两条导入路径共用同一份规则，不会出现「粘贴的和上传的分得不一样」。
 */
function csvToText(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return '';

  const header = rows[0].map(h => h.trim().toLowerCase());
  const map = {};
  for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
    const idx = header.findIndex(h => hints.some(hint => h.includes(hint.toLowerCase())));
    if (idx >= 0) map[field] = idx;
  }

  // 认不出表头就退化成「整行拼成一句」，至少不丢内容
  const hasHeader = Object.keys(map).length > 0;
  const body = hasHeader ? rows.slice(1) : rows;

  return body.map(r => {
    if (!hasHeader) return r.map(c => c.trim()).filter(Boolean).join(' ');

    const parts = [];
    if (map.owner !== undefined && r[map.owner]) parts.push(r[map.owner].trim() + '：');
    if (map.project !== undefined && r[map.project]) parts.push(`【${r[map.project].trim()}】`);
    const main = map.text !== undefined ? (r[map.text] || '') : r.join(' ');
    parts.push(main.trim());
    if (map.status !== undefined && r[map.status]) parts.push(`（${r[map.status].trim()}）`);
    return parts.join('').trim();
  }).filter(Boolean).join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 本周概况
//
// 只算「当周数据就能算出来」的部分。覆盖度、周对比、滞留项需要
// 人员名单和历史数据，属于阶段 4，这里不假装能算。
// ═══════════════════════════════════════════════════════════════

function summarize(items, similar) {
  const live = items.filter(it => !it.mergedInto);

  const count = (key) => {
    const m = {};
    for (const it of live) {
      const k = it[key] || '（未填）';
      m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  const noMetrics = live.filter(it => !it.metrics.length && it.category !== '计划');

  return {
    total: live.length,
    byOwner: count('owner'),
    byCategory: count('category'),
    byStatus: count('status'),
    blocked: live.filter(it => it.status === '阻塞').map(it => it.id),
    noMetrics: noMetrics.map(it => it.id),
    noMetricsRate: live.length ? Math.round(noMetrics.length / live.length * 100) : 0,
    needsReview: live.filter(it => it.confidence < 0.6 && !it.reviewed).map(it => it.id),
    duplicateStrong: similar.filter(p => p.level === 'strong').length,
    duplicateWeak: similar.filter(p => p.level === 'weak').length,
  };
}

// ═══════════════════════════════════════════════════════════════
// ISO 周编号
// 用 2026-W31 而不是「第 31 周」，跨年时不会有歧义
// ═══════════════════════════════════════════════════════════════

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;          // 周日算第 7 天
  d.setUTCDate(d.getUTCDate() + 4 - day);  // 挪到本周四 —— ISO 规定周四所在的年就是这周的年
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = {
  splitEntries, classify, detectStatus, extractMetrics,
  normalize, trigrams, jaccard, similarity, findSimilar,
  buildItems, csvToText, parseCsv, summarize, isoWeek, newId,
  STRONG, WEAK,
};
