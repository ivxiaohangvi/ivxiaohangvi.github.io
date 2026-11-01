import type { CollectionEntry } from 'astro:content';

type WordEntry = CollectionEntry<'diary'> | CollectionEntry<'moments'> | CollectionEntry<'blog'>;

export interface WordFieldWord {
  word: string;
  count: number;
  lastSeen: Date | null;
  tier: 1 | 2 | 3 | 4;
  fade: number;
}

export interface WordField {
  words: WordFieldWord[];
  sourceCount: number;
}

const STOP = new Set(
  `今天 明天 昨天 现在 当时 以前 以后 之后 之前 最近 最后 最初 一天 一次 一边 一起 一会儿 一条 一点 一片 一下 一些 一直 一般 一样 第一 第二 第三 一个 什么 这么 那么 这样 那样 这个 那个 哪个 这些 那些 哪些 怎么 为什么 为了 因为 所以 但是 如果 已经 真的 应该 知道 觉得 感觉 时候 东西 事情 地方 问题 方面 内容 方式 样子 名字 时间 今年 去年 明年 上周 下周 早上 中午 晚上 下午 上午 我们 你们 他们 她们 它们 咱们 自己 别人 人家 大家 其他 另外 同时 而且 而是 或者 然后 以及 还有 这里 那里 其实 反正 似乎 好像 比较 非常 特别 虽然 即使 除非 只要 只有 所有 每个 各种 目前 大概 估计 总是 经常 偶尔 也是 都是 不是 不过 只是 于是 甚至 差不多 怎么办 有没有 是不是 会不会 能不能 要不要 好的 是的 对吧 哈哈 嘿嘿 呜呜 嘻嘻 记录 日记 文章 博客 网站 页面 首页 链接 标题 标签 分类 评论 留言 分享 收藏 点赞 关注 订阅 搜索 浏览 访问 点击 输入 输出 上传 下载 安装 更新 版本 功能 示例 很多 很少 很好 看看 想想 试试 走走 听听 说说 慢慢 悄悄 静静 记住 记得 可以 有点 有些 有的 开始 直接 突然 可能 非要 好好 好多 出来 回去 回来 起来 下来 下去 上来 上去 进来 进去 过来 过去 出去 明明 个人 下次 旁边 准备 打算 机会 送给 发生 看到 听到 闻到 了解 想要 愿意 认为 表示 出现 存在 变成 成为 进行 完成 得到 获得 保持 包括 属于 位于 关于 对于 由于 根据 按照 作为 形成 产生 引起 导致 造成 影响 关系 情况 状态 过程 结果 原因 意义 作用 目的 水平 能力 条件 基础 方法 要求 需要 发展 实现 发现 告诉 说话 的话 了一 以为 心里 一圈 一共 肯定 随便 依旧 一切 小时 图片 研究 希望`.split(/\s+/),
);

/**
 * 人工加权：站内文章里的技术词。
 * boost 是“虚拟篇数”，用来抵消日记语料的频次优势；只有文章里真出现过才生效。
 * 想让技术词更靠中心就调大 boost，想让生活词回来就调小。
 */
const TECH_EMPHASIS = new Map<string, { boost: number; label: string }>([
  ['astro', { boost: 18, label: 'Astro' }],
  ['gsap', { boost: 16, label: 'GSAP' }],
  ['github', { boost: 12, label: 'GitHub' }],
  ['pagefind', { boost: 10, label: 'Pagefind' }],
  ['动画', { boost: 10, label: '动画' }],
  ['构建', { boost: 10, label: '构建' }],
  ['代码', { boost: 8, label: '代码' }],
  ['索引', { boost: 8, label: '索引' }],
  ['前端', { boost: 8, label: '前端' }],
  ['部署', { boost: 8, label: '部署' }],
]);

const PRONOUN_PREFIX = /^[我你他她它咱您谁这那哪每各某]/;
const FILLER_PREFIX = /^[不没也又还就都很最更挺蛮再才只正刚]/;
const TAIL_PARTICLE = /[是的了着过吗呢吧啊呀哦嘛啦]$/;
const TAIL_EXCEPTIONS = new Set([
  '了解',
  '了不起',
  '难过',
  '路过',
  '错过',
  '通过',
  '超过',
  '活着',
  '随着',
  '意味着',
  '目的',
]);

const SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function cleanMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_~|]/g, ' ');
}

export function tokenize(body: string): string[] {
  const tokens: string[] = [];
  for (const part of SEGMENTER.segment(cleanMarkdown(body))) {
    if (!part.isWordLike) continue;
    const token = part.segment.trim();
    if (!token || /\d/.test(token)) continue;
    if (STOP.has(token)) continue;
    if (/^[a-z]$/i.test(token)) continue;
    if (PRONOUN_PREFIX.test(token) && token.length <= 3) continue;
    if (FILLER_PREFIX.test(token) && token.length <= 3) continue;
    if (token.includes('是')) continue;
    if (TAIL_PARTICLE.test(token) && !TAIL_EXCEPTIONS.has(token)) continue;
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length < 2) continue;
    tokens.push(token);
  }
  return tokens;
}

function entryDate(entry: WordEntry): Date | null {
  const data = entry.data as { date?: Date; pubDate?: Date };
  return data.pubDate ?? data.date ?? null;
}

function isExcluded(entry: WordEntry): boolean {
  const data = entry.data as { locked?: boolean; sample?: boolean; draft?: boolean };
  return Boolean(data.locked || data.sample || data.draft);
}

function isSampleBlog(entry: WordEntry): boolean {
  if (entry.collection !== 'blog') return false;
  const tags = (entry.data as { tags?: string[] }).tags;
  return Array.isArray(tags) && tags.includes('示例');
}

function blogText(entry: WordEntry): string {
  if (entry.collection !== 'blog') return '';
  const data = entry.data as { title?: string; description?: string; tags?: string[] };
  return [data.title ?? '', data.description ?? '', ...(data.tags ?? []), entry.body ?? ''].join('\n');
}

function hasTerm(text: string, term: string): boolean {
  if (/^[a-z]+$/.test(term)) {
    return new RegExp(`(?<![a-z])${term}(?![a-z])`, 'i').test(text);
  }
  return text.includes(term);
}

export function buildWordField(entries: WordEntry[], limit = 36, minCount = 3): WordField {
  const sources = entries.filter((entry) => !isExcluded(entry) && Boolean(entry.body));
  const newest = sources.reduce<number | null>((latest, entry) => {
    const date = entryDate(entry);
    if (!date) return latest;
    return latest === null || date.valueOf() > latest ? date.valueOf() : latest;
  }, null);

  const stats = new Map<string, { word: string; count: number; lastSeen: number | null }>();

  for (const entry of sources) {
    const seen = new Set<string>();
    for (const token of tokenize(entry.body ?? '')) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = stats.get(key);
      const date = entryDate(entry);
      const stamp = date ? date.valueOf() : null;
      if (existing) {
        existing.count += 1;
        if (stamp !== null && (existing.lastSeen === null || stamp > existing.lastSeen)) {
          existing.lastSeen = stamp;
        }
      } else {
        stats.set(key, { word: token, count: 1, lastSeen: stamp });
      }
    }
  }

  const techStats = new Map<string, { articles: number; lastSeen: number | null }>();
  for (const entry of sources) {
    if (entry.collection !== 'blog' || isSampleBlog(entry)) continue;
    const text = blogText(entry);
    const date = entryDate(entry);
    const stamp = date ? date.valueOf() : null;
    for (const term of TECH_EMPHASIS.keys()) {
      if (!hasTerm(text, term)) continue;
      const existing = techStats.get(term);
      if (existing) {
        existing.articles += 1;
        if (stamp !== null && (existing.lastSeen === null || stamp > existing.lastSeen)) {
          existing.lastSeen = stamp;
        }
      } else {
        techStats.set(term, { articles: 1, lastSeen: stamp });
      }
    }
  }

  type Candidate = { word: string; count: number; lastSeen: number | null; score: number; tech: boolean };
  const candidates = new Map<string, Candidate>();
  for (const item of stats.values()) {
    if (item.count < minCount) continue;
    candidates.set(item.word.toLowerCase(), { ...item, score: item.count, tech: false });
  }
  for (const [term, meta] of TECH_EMPHASIS) {
    const evidence = techStats.get(term);
    if (!evidence) continue;
    const base = stats.get(term);
    const count = Math.max(base?.count ?? 0, evidence.articles);
    candidates.set(term, {
      word: base?.word ?? meta.label,
      count,
      lastSeen: base?.lastSeen ?? evidence.lastSeen,
      score: count + meta.boost,
      tech: true,
    });
  }

  const ranked = [...candidates.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.tech) - Number(a.tech) ||
        b.count - a.count ||
        a.word.localeCompare(b.word),
    )
    .slice(0, limit);

  const words = ranked.map((item, index) => {
    const ageDays =
      newest !== null && item.lastSeen !== null ? (newest - item.lastSeen) / 86_400_000 : 0;
    const fade = ageDays <= 30 ? 1 : ageDays <= 120 ? 0.84 : 0.68;
    const tier: WordFieldWord['tier'] = index < 6 ? 1 : index < 16 ? 2 : index < 28 ? 3 : 4;
    return {
      word: item.word,
      count: item.count,
      lastSeen: item.lastSeen === null ? null : new Date(item.lastSeen),
      tier,
      fade,
    };
  });

  return { words, sourceCount: sources.length };
}
