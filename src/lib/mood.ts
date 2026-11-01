export type MoodTone = 'joy' | 'ease' | 'still' | 'low' | 'sad';

/** 稳定的心情键：App 里可以换图标，所以 key 才是权威 */
export type MoodKey = 'veryHappy' | 'happy' | 'neutral' | 'sad' | 'verySad';

export interface MoodInfo {
  emoji: string;
  label: string;
  tone: MoodTone;
}

const MOOD_KEY_INFO: Record<MoodKey, MoodInfo> = {
  veryHappy: { emoji: '😊', label: '开心', tone: 'joy' },
  happy: { emoji: '🙂', label: '愉悦', tone: 'ease' },
  neutral: { emoji: '😐', label: '平静', tone: 'still' },
  sad: { emoji: '😕', label: '低落', tone: 'low' },
  verySad: { emoji: '😔', label: '难过', tone: 'sad' },
};

const MOODS: Record<string, { label: string; tone: MoodTone }> = {
  '😊': { label: '开心', tone: 'joy' },
  '🙂': { label: '愉悦', tone: 'ease' },
  '😐': { label: '平静', tone: 'still' },
  '😕': { label: '低落', tone: 'low' },
  '😔': { label: '难过', tone: 'sad' },
};

const normalize = (emoji: string): string => emoji.replace(/\uFE0F/g, '');

const ALIASES: Record<string, string> = {
  '☺': '😊',
};

const NORMALIZED = new Map(
  Object.entries(MOODS).map(([emoji, info]) => [normalize(emoji), { emoji, ...info }] as const),
);

export function moodKeyInfo(moodKey?: string): MoodInfo | null {
  if (!moodKey) return null;
  return MOOD_KEY_INFO[moodKey as MoodKey] ?? null;
}

/**
 * 先认 moodKey：认识就完全忽略 emoji（用户可能已经换了图标）。
 * key 缺失或不认识时，才回落到原来的 emoji 表。
 */
export function moodInfo(mood?: string, moodKey?: string): MoodInfo | null {
  const keyed = moodKeyInfo(moodKey);
  if (keyed) return keyed;
  if (!mood) return null;
  const key = normalize(mood);
  return NORMALIZED.get(ALIASES[key] ?? key) ?? null;
}
