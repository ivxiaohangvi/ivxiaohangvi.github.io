/**
 * 搜索页的「打字机」动效：点词场里的词时，用输入法的节奏把词逐字打进搜索框。
 *
 * 只保留日记打字机里的两样东西：拼音组合区（全拼）与逐字显影；
 * 不做打错字再退格，也不做「未打出的字是暗的」那套排版玩法——搜索框里
 * 只出现已经敲定的字。
 *
 * 这里是纯逻辑，不碰 DOM：页面传入 hooks 决定怎么画，测试里换成记录器。
 */

export interface TypingHooks {
  /** 把已经敲定的内容写进搜索框 */
  setValue(value: string): void;
  /** 更新输入法组合区（拼音） */
  compose(text: string): void;
  /** 更新候选字；active 是当前高亮项 */
  candidates(chars: string[], active: number): void;
  /** 收起输入法面板 */
  hideIme(): void;
}

export interface TypeWordOptions {
  word: string;
  /** 与 [...word] 逐字对齐的拼音；长度对不上时按「没有拼音数据」处理 */
  syllables: string[];
  /** 某个音节的候选字，第一个通常是目标字 */
  candidatesFor?: (syllable: string, char: string) => string[];
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

/** 节奏取自日记打字机：按键间隔 + 读候选 + 敲定，但整体更短，毕竟只有两三个字。 */
const START_DELAY: readonly [number, number] = [90, 170];
const KEY_DELAY: readonly [number, number] = [55, 95];
const READ_DELAY: readonly [number, number] = [150, 260];
const SETTLE_DELAY: readonly [number, number] = [70, 130];
const COMMIT_DELAY: readonly [number, number] = [70, 120];
const CHAR_GAP: readonly [number, number] = [60, 130];
const PLAIN_DELAY: readonly [number, number] = [90, 160];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pick = (range: readonly [number, number], random: () => number): number =>
  Math.round(range[0] + random() * (range[1] - range[0]));

/**
 * 把 word 逐字「打」进搜索框。
 * @returns 全部打完为 true；被打断为 false（此时输入框里停在已经敲出的前缀）。
 */
export async function typeWordIntoSearch(options: TypeWordOptions): Promise<boolean> {
  const { word, hooks } = options;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const cancelled = options.isCancelled ?? (() => false);

  const chars = [...word];
  const syllables = options.syllables.length === chars.length ? options.syllables : [];

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

    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      const syllable = syllables[index] ?? '';
      const prefix = chars.slice(0, index + 1).join('');

      if (HAN.test(char) && SYLLABLE.test(syllable)) {
        // 全拼：逐个字母进组合区，然后读候选、敲字。
        let compose = '';
        for (const letter of syllable) {
          compose += letter;
          hooks.compose(compose);
          await wait(pick(KEY_DELAY, random));
          if (cancelled()) return false;
        }
        const candidates = options.candidatesFor?.(syllable, char) ?? [char];
        hooks.candidates(candidates, 0);
        await wait(pick(READ_DELAY, random));
        if (cancelled()) return false;
        await wait(pick(SETTLE_DELAY, random));
        if (cancelled()) return false;
        hooks.compose('');
        hooks.setValue(prefix);
        await wait(pick(COMMIT_DELAY, random));
        if (cancelled()) return false;
      } else {
        // 英文/数字/缺拼音的词：没有输入法可模拟，直接落字。
        hooks.setValue(prefix);
        await wait(pick(PLAIN_DELAY, random));
        if (cancelled()) return false;
      }

      if (index < chars.length - 1) {
        await wait(pick(CHAR_GAP, random));
        if (cancelled()) return false;
      }
    }

    hooks.hideIme();
    return true;
  } finally {
    // 被打断时也要收起面板，避免残留。
    if (cancelled()) hooks.hideIme();
  }
}
