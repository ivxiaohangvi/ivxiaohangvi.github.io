import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

/** 列表每页条目数：首屏只渲染这一页，其余由滚动加载或无 JS 分页回退页提供 */
export const DIARY_PAGE_SIZE = 24;

export async function getSortedDiaryEntries(): Promise<CollectionEntry<'diary'>[]> {
  const entries = await getCollection('diary');
  return entries.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export const diaryPath = (page: number) => (page <= 1 ? '/diary/' : `/diary/page/${page}/`);

export function plainText(markdown = ''): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
