import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

import { beijingParts, beijingYear } from './date';
import { moodInfo } from './mood';
import type { MoodTone } from './mood';
import { getPhotoRolls } from './photo-rolls';

export interface ArchiveEntry {
  id: string;
  title: string;
  href: string;
  date: Date;
  locked: boolean;
  mood?: string;
}

export interface ArchiveMonth {
  /** 两位月份，'01'…'12' */
  month: string;
  /** 中文月名，'一月'…'十二月' */
  nameCn: string;
  key: string;
  href: string;
  entries: ArchiveEntry[];
  count: number;
  isEmpty: boolean;
  /** 当月出现次数最多的心情，决定书脊颜色 */
  tone: MoodTone | null;
  tones: Partial<Record<MoodTone, number>>;
}

export interface ArchiveYear {
  year: string;
  href: string;
  months: ArchiveMonth[];
  count: number;
  filled: number;
}

export const TONE_EMOJI: Record<MoodTone, string> = {
  joy: '😊',
  ease: '🙂',
  still: '😐',
  low: '😕',
  sad: '😔',
};

const MONTH_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const TONE_ORDER: MoodTone[] = ['joy', 'ease', 'still', 'low', 'sad'];

function toArchiveEntry(entry: CollectionEntry<'diary'>): ArchiveEntry {
  return {
    id: entry.id,
    title: entry.data.title?.trim() || '无题',
    href: `/diary/${entry.id}/`,
    date: entry.data.date,
    locked: entry.data.locked,
    mood: entry.data.mood,
  };
}

function countTones(entries: CollectionEntry<'diary'>[]): Partial<Record<MoodTone, number>> {
  const tones: Partial<Record<MoodTone, number>> = {};
  for (const entry of entries) {
    const info = moodInfo(entry.data.mood, entry.data.moodKey);
    if (!info) continue;
    tones[info.tone] = (tones[info.tone] ?? 0) + 1;
  }
  return tones;
}

function dominantTone(tones: Partial<Record<MoodTone, number>>): MoodTone | null {
  let best: MoodTone | null = null;
  let bestCount = 0;
  for (const tone of TONE_ORDER) {
    const count = tones[tone] ?? 0;
    if (count > bestCount) {
      best = tone;
      bestCount = count;
    }
  }
  return best;
}

async function buildArchive(): Promise<ArchiveYear[]> {
  const entries = await getCollection('diary');
  const sorted = [...entries].sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  const byYear = new Map<string, Map<string, CollectionEntry<'diary'>[]>>();
  for (const entry of sorted) {
    const { year, month } = beijingParts(entry.data.date);
    let months = byYear.get(year);
    if (!months) {
      months = new Map();
      byYear.set(year, months);
    }
    const list = months.get(month);
    if (list) list.push(entry);
    else months.set(month, [entry]);
  }

  const years = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));

  return years.map((year) => {
    const monthMap = byYear.get(year) ?? new Map();
    const months: ArchiveMonth[] = Array.from({ length: 12 }, (_, index) => {
      const month = String(index + 1).padStart(2, '0');
      const list = monthMap.get(month) ?? [];
      const tones = countTones(list);
      return {
        month,
        nameCn: `${MONTH_NAMES[index]}月`,
        key: `${year}-${month}`,
        href: `/diary/archive/${year}/${month}/`,
        entries: list.map(toArchiveEntry),
        count: list.length,
        isEmpty: list.length === 0,
        tone: dominantTone(tones),
        tones,
      };
    });

    return {
      year,
      href: `/diary/archive/${year}/`,
      months,
      count: months.reduce((total, month) => total + month.count, 0),
      filled: months.filter((month) => !month.isEmpty).length,
    };
  });
}

let archivePromise: Promise<ArchiveYear[]> | null = null;

export function getDiaryArchive(): Promise<ArchiveYear[]> {
  // dev 下不缓存，改 Markdown 能立刻看到书架变化
  if (import.meta.env.DEV) return buildArchive();
  archivePromise ??= buildArchive();
  return archivePromise;
}

export interface ArchiveRoll {
  years: ArchiveYear[];
  months: ArchiveMonth[];
  total: number;
  monthsCount: number;
}

export async function getArchiveRoll(): Promise<ArchiveRoll> {
  const years = await getDiaryArchive();
  const months = years.flatMap((year) => year.months.filter((month) => !month.isEmpty));
  months.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return {
    years,
    months,
    total: months.reduce((sum, month) => sum + month.count, 0),
    monthsCount: months.length,
  };
}

export function neighbourMonths(
  months: ArchiveMonth[],
  key: string,
): { prev: ArchiveMonth | null; next: ArchiveMonth | null } {
  const index = months.findIndex((month) => month.key === key);
  if (index < 0) return { prev: null, next: null };
  // months 已是倒序（新→旧）：prev = 更旧的一本，next = 更新的一本
  return {
    prev: months[index + 1] ?? null,
    next: months[index - 1] ?? null,
  };
}

/* ────────────────────────────────────────────────────────────
 * 归档家具：四种皮共用同一份数据形状
 *   book     一本书 = 一个月（日记）
 *   drawer   一格抽屉 = 一年（文章）
 *   canister 一罐胶卷 = 一卷相册（摄影）
 *   box      一只箱子 = 一个月（动态）
 *   bottle   一只玻璃瓶 = 一个月（动态），一粒光 = 一条
 * ──────────────────────────────────────────────────────────── */

export type FurnitureSkin = 'book' | 'drawer' | 'canister' | 'bottle';

export interface FurnitureItem {
  key: string;
  /** 面上最大的字：'08' / '2026' / '示例·天台' */
  label: string;
  /** 小字，如 '月' / 'ROLL' */
  sub: string;
  count: number;
  countLabel: string;
  href: string;
  aria: string;
  tone?: MoodTone | null;
  isEmpty?: boolean;
}

export interface FurnitureUnit {
  key: string;
  label: string;
  meta: string;
  items: FurnitureItem[];
}

const pad2 = (value: string | number) => String(value).padStart(2, '0');

export async function getDiaryFurniture(): Promise<FurnitureUnit[]> {
  const years = await getDiaryArchive();
  return years.map((year) => ({
    key: year.year,
    label: year.year,
    meta: `${pad2(year.filled)} MONTHS · ${year.count}`,
    items: year.months.map((month) => ({
      key: month.key,
      label: month.month,
      sub: '月',
      count: month.count,
      countLabel: `${month.count} 篇`,
      href: month.href,
      aria: `${year.year} 年 ${month.nameCn}，${month.count} 篇日记`,
      tone: month.tone,
      isEmpty: month.isEmpty,
    })),
  }));
}

export async function getBlogFurniture(): Promise<FurnitureUnit[]> {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );

  const byYear = new Map<string, CollectionEntry<'blog'>[]>();
  for (const post of posts) {
    const year = beijingYear(post.data.pubDate);
    const list = byYear.get(year) ?? [];
    list.push(post);
    byYear.set(year, list);
  }

  const years = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));

  return [
    {
      key: 'blog',
      label: '文章',
      meta: `${pad2(years.length)} YEARS · ${posts.length}`,
      items: years.map((year) => {
        const list = byYear.get(year) ?? [];
        return {
          key: year,
          label: year,
          sub: '年',
          count: list.length,
          countLabel: `${list.length} 篇`,
          href: `/blog/#year-${year}`,
          aria: `${year} 年，${list.length} 篇文章`,
        };
      }),
    },
  ];
}

export async function getMomentFurniture(): Promise<FurnitureUnit[]> {
  const moments = (await getCollection('moments')).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf(),
  );

  const byYear = new Map<string, Map<string, CollectionEntry<'moments'>[]>>();
  for (const moment of moments) {
    const { year, month } = beijingParts(moment.data.date);
    let months = byYear.get(year);
    if (!months) {
      months = new Map();
      byYear.set(year, months);
    }
    const list = months.get(month);
    if (list) list.push(moment);
    else months.set(month, [moment]);
  }

  const years = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));

  return years.map((year) => {
    const monthMap = byYear.get(year) ?? new Map<string, CollectionEntry<'moments'>[]>();
    const total = [...monthMap.values()].reduce((sum, list) => sum + list.length, 0);
    const filled = monthMap.size;
    return {
      key: year,
      label: year,
      meta: `${pad2(filled)} MONTHS · ${total}`,
      // 一年的 12 个格子都摆出来，没写的月份留一个空位
      items: Array.from({ length: 12 }, (_, index) => {
        const month = pad2(index + 1);
        const list = monthMap.get(month) ?? [];
        const tone = dominantTone(
          list.reduce<Partial<Record<MoodTone, number>>>((tones, moment) => {
            const info = moodInfo(moment.data.mood, moment.data.moodKey);
            if (info) tones[info.tone] = (tones[info.tone] ?? 0) + 1;
            return tones;
          }, {}),
        );
        const name = MONTH_NAMES[index];
        return {
          key: `${year}-${month}`,
          label: month,
          sub: '月',
          count: list.length,
          countLabel: list.length === 0 ? '空' : `${list.length} 则`,
          href: list.length === 0 ? '' : `/moments/#m-${year}-${month}`,
          aria:
            list.length === 0
              ? `${year} 年 ${name}月，还没有动态`
              : `${year} 年 ${name}月，${list.length} 则动态`,
          tone,
          isEmpty: list.length === 0,
        };
      }),
    };
  });
}

export async function getPhotoFurniture(): Promise<FurnitureUnit[]> {
  const rolls = (await getPhotoRolls()).filter((roll) => !roll.isEmpty);
  const total = rolls.reduce((sum, roll) => sum + roll.frames.length, 0);
  return [
    {
      key: 'photos',
      label: '相册',
      meta: `${pad2(rolls.length)} ROLLS · ${total} FRAMES`,
      items: rolls.map((roll, index) => ({
        key: roll.key,
        label: roll.title,
        sub: roll.years.join('–'),
        count: roll.frames.length,
        countLabel: `${roll.frames.length} 张`,
        href: `/photos/#roll-${pad2(index + 1)}`,
        aria: `${roll.title}，${roll.frames.length} 张`,
      })),
    },
  ];
}
