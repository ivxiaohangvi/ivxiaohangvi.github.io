import { getCollection, type CollectionEntry } from 'astro:content';
import { beijingYear } from './date';

export type Photo = CollectionEntry<'photos'>;

export interface PhotoRoll {
  /** 稳定键：相册 id，或自动分卷时的 roll / 年份 */
  key: string;
  /** 卷标：相册标题，或自动分卷的 roll / 年份 */
  title: string;
  frames: Photo[];
  /** 排卷用的日期：相册日期，或本卷最早一格 */
  date: Date;
  years: string[];
  /** 相册里一帧都没有，也要出一条空卷 */
  isEmpty: boolean;
  side: 'left' | 'right';
  index: number;
  isLast: boolean;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('zh-CN');

const yearOf = (photo: Photo) => beijingYear(photo.data.date);

/**
 * 一卷 = 一个相册。显式相册（photoRolls）先落座，照片按 roll 匹配
 * 相册 id / 标题后归卷；没有对应相册的 roll 仍按旧规则自动分卷，
 * 所以只加照片、不建相册也能直接长出新胶卷。
 */
export async function getPhotoRolls(): Promise<PhotoRoll[]> {
  const [photos, albums] = await Promise.all([getCollection('photos'), getCollection('photoRolls')]);

  const sortedPhotos = [...photos].sort((a, b) => a.data.date.valueOf() - b.data.date.valueOf());

  const albumByAlias = new Map<string, CollectionEntry<'photoRolls'>>();
  for (const album of albums) {
    for (const alias of [album.id, album.data.title]) {
      const key = normalize(alias);
      if (key && !albumByAlias.has(key)) albumByAlias.set(key, album);
    }
  }

  type Bucket = {
    key: string;
    title: string;
    frames: Photo[];
    date: Date;
  };

  const buckets = new Map<string, Bucket>();
  for (const album of albums) {
    buckets.set(`album:${album.id}`, {
      key: album.id,
      title: album.data.title,
      frames: [],
      date: album.data.date,
    });
  }

  for (const photo of sortedPhotos) {
    const roll = photo.data.roll?.trim();
    const album = roll ? albumByAlias.get(normalize(roll)) : undefined;
    if (album) {
      buckets.get(`album:${album.id}`)!.frames.push(photo);
      continue;
    }
    const key = roll || yearOf(photo);
    const bucketKey = `auto:${key}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.frames.push(photo);
    else
      buckets.set(bucketKey, {
        key,
        title: key,
        frames: [photo],
        date: photo.data.date,
      });
  }

  const rolls = [...buckets.values()]
    .sort((a, b) => {
      const delta = a.date.valueOf() - b.date.valueOf();
      if (delta !== 0) return delta;
      return a.title.localeCompare(b.title, 'zh-CN');
    })
    .map((bucket, index, all) => {
      const years = [...new Set(bucket.frames.map(yearOf))].sort();
      const yearsOrDate = years.length > 0 ? years : [beijingYear(bucket.date)];
      return {
        key: bucket.key,
        title: bucket.title,
        frames: bucket.frames,
        date: bucket.date,
        years: yearsOrDate,
        isEmpty: bucket.frames.length === 0,
        side: index % 2 === 0 ? ('left' as const) : ('right' as const),
        index,
        isLast: index === all.length - 1,
      };
    });

  return rolls;
}
