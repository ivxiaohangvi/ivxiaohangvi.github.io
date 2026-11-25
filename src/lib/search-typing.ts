/**
 * 搜索页的「打字机」动效：点词场里的词时，把整个词的拼音连续敲进组合区，
 * 拼音打完后给出候选词，再一次性把整词落进搜索框。
 *
 * 只保留日记打字机里的两样东西：拼音组合区（全拼，音节之间用 ' 分隔）与候选面板；
 * 不做打错字再退格，也不做「未打出的字是暗的」那套排版玩法——搜索框里只出现
 * 已经敲定的完整词。
 *
 * 这里是纯逻辑，不碰 DOM：页面传入 hooks 决定怎么画，测试里换成记录器。
 */

export interface TypingHooks {
  /** 把已经敲定的内容写进搜索框 */
  setValue(value: string): void;
  /** 更新输入法组合区（拼音） */
  compose(text: string): void;
  /** 更新候选列表；active 是当前高亮项。打字过程中是当前音节的候选字，打完后是候选词 */
  candidates(items: string[], active: number): void;
  /** 收起输入法面板 */
  hideIme(): void;
}

export interface TypeWordOptions {
  word: string;
  /** 与 [...word] 逐字对齐的拼音；长度对不上时按「没有拼音数据」处理 */
  syllables: string[];
  /** 打字过程中某个音节的候选字，目标字放第一位 */
  charCandidatesFor?: (syllable: string, char: string) => string[];
  /** 拼音打完后展示的候选词，第一个是目标词 */
  wordCandidates?: string[];
  hooks: TypingHooks;
  /** 用户开了「减少动态效果」时直接落字 */
  reduceMotion?: boolean;
  /** 返回 true 表示中途被打断（用户开始自己输入、点了别的词等） */
  isCancelled?: () => boolean;
  /** 供测试注入 */
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
}

const HAN = /\p{Script=Han}/u;
const SYLLABLE = /^[a-z]+$/;

/** 节奏取自日记打字机：连打整词拼音 + 读候选词 + 一次落词。 */
const START_DELAY: readonly [number, number] = [90, 170];
const KEY_DELAY: readonly [number, number] = [55, 95];
const SYLLABLE_GAP: readonly [number, number] = [20, 60];
const READ_DELAY: readonly [number, number] = [150, 260];
const SETTLE_DELAY: readonly [number, number] = [70, 130];
const COMMIT_DELAY: readonly [number, number] = [70, 120];
const PLAIN_DELAY: readonly [number, number] = [90, 160];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pick = (range: readonly [number, number], random: () => number): number =>
  Math.round(range[0] + random() * (range[1] - range[0]));

/** 按音节长度把已敲的字母分组，满一个音节后插入全拼分隔符（与日记打字机的 composeLabel 一致）。 */
export function composeLabel(syllables: string[], raw: string): string {
  if (syllables.length < 2) return raw;

  const parts: string[] = [];
  let offset = 0;
  for (const syllable of syllables) {
    if (offset >= raw.length) break;
    const end = Math.min(raw.length, offset + syllable.length);
    parts.push(raw.slice(offset, end));
    offset = end;
  }
  if (offset < raw.length) parts.push(raw.slice(offset));
  return parts.join("'");
}

/**
 * 把 word 整个「打」进搜索框：拼音一字不漏地连打，最后整词落字。
 * @returns 全部打完为 true；被打断为 false（此时输入框里没有新内容）。
 */
export async function typeWordIntoSearch(options: TypeWordOptions): Promise<boolean> {
  const { word, hooks } = options;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const cancelled = options.isCancelled ?? (() => false);

  const chars = [...word];
  const syllables = options.syllables.length === chars.length ? options.syllables : [];
  const canCompose =
    chars.length > 0 &&
    syllables.length === chars.length &&
    chars.every((char, index) => HAN.test(char) && SYLLABLE.test(syllables[index] ?? ''));

  if (chars.length === 0) {
    hooks.setValue(word);
    hooks.hideIme();
    return true;
  }

  if (options.reduceMotion) {
    hooks.setValue(word);
    hooks.hideIme();
    return true;
  }

  try {
    await wait(pick(START_DELAY, random));
    if (cancelled()) return false;

    if (!canCompose) {
      // 英文/数字/缺拼音的词：没有输入法可模拟，直接落字。
      hooks.setValue(word);
      await wait(pick(PLAIN_DELAY, random));
      if (cancelled()) return false;
      hooks.hideIme();
      return true;
    }

    // 整词连续全拼：字母一个个进组合区，音节之间只隔极短一瞬，不落字、不换行。
    let raw = '';
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      const syllable = syllables[index]!;
      const charCandidates = options.charCandidatesFor?.(syllable, char) ?? [char];
      hooks.candidates(charCandidates, 0);

      for (const letter of syllable) {
        raw += letter;
        hooks.compose(composeLabel(syllables, raw));
        await wait(pick(KEY_DELAY, random));
        if (cancelled()) return false;
      }

      if (index < chars.length - 1) {
        await wait(pick(SYLLABLE_GAP, random));
        if (cancelled()) return false;
      }
    }

    // 拼音全部敲完：候选面板换成候选词，读一下，再整词落字。
    const candidates = options.wordCandidates?.length ? options.wordCandidates : [word];
    hooks.candidates(candidates, 0);
    await wait(pick(READ_DELAY, random));
    if (cancelled()) return false;
    await wait(pick(SETTLE_DELAY, random));
    if (cancelled()) return false;

    hooks.compose('');
    hooks.setValue(word);
    await wait(pick(COMMIT_DELAY, random));
    if (cancelled()) return false;

    hooks.hideIme();
    return true;
  } finally {
    // 被打断时也要收起面板，避免残留。
    if (cancelled()) hooks.hideIme();
  }
}
