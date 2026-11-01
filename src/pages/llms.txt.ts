/**
 * 生成 /llms.txt：面向 AI 爬虫与聊天助手的站点内容索引（https://llmstxt.org）
 * 构建时静态生成纯文本，列出全站结构与最新内容
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { siteConfig } from '../config';
import { beijingDateDot } from '../lib/date';

export const GET: APIRoute = async ({ site }) => {
  const origin = site ?? new URL('https://example.com');
  const [posts, photos, tools] = await Promise.all([
    getCollection('blog', ({ data }) => !data.draft),
    getCollection('photos'),
    getCollection('tools'),
  ]);
  const byDateDesc = <T extends { data: { date?: Date; pubDate?: Date } }>(a: T, b: T) =>
    (b.data.date ?? b.data.pubDate)!.valueOf() - (a.data.date ?? a.data.pubDate)!.valueOf();
  posts.sort(byDateDesc as never);
  photos.sort(byDateDesc as never);

  const url = (p: string) => new URL(p, origin).href;

  const lines: string[] = [
    `# ${siteConfig.title}`,
    '',
    `> ${siteConfig.description}`,
    '',
    `${siteConfig.author}（${siteConfig.alias}，${siteConfig.tagline}）的无限空间。`,
    '站点名 moxo：字标把 oxo 收成莫比乌斯环（∞），所以视觉上写作 m∞；文字与元信息使用 moxo。',
    '本索引只收录公开的长文章（blog）、摄影（photos）与自制工具（tools）。',
    '',
    '## 使用政策',
    '',
    '- 日记（/diary/）与动态（/moments/）是私人记录，不在本索引内，也不对外开放抓取。',
    '- 引用、摘要或由文章生成回答时，必须注明作者「背井离江的汤姆」并附上 moxo.cc 上的原文链接。',
    '- 禁止抓取 /diary/、/moments/、/void/，这些路径已设置 noindex，也不得用于模型训练。',
    '- 无法保证署名与原文链接时，请不要使用本站内容。',
    '',
    '## 页面',
    '',
    `- [文章](${url('blog/')})`,
    `- [摄影](${url('photos/')})`,
    `- [工具](${url('tools/')})`,
    `- [关于](${url('about/')})`,
    `- [RSS](${url('rss.xml')})`,
    '',
    '## 文章',
    '',
    ...posts.map(
      (post) =>
        `- [${post.data.title}](${url(`blog/${post.id}/`)}): ${post.data.description ?? ''}（${beijingDateDot(post.data.pubDate)}）`,
    ),
    '',
    '## 工具',
    '',
    ...tools.map((t) => `- [${t.data.name}](${t.data.url}): ${t.data.description}`),
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
