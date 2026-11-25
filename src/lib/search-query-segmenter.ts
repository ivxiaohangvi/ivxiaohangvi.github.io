/**
 * Pagefind 查询端用浏览器自带的 Intl.Segmenter 切中文，索引端却是构建期固定分词。
 * 两边口径不一致时（Safari / 部分 WebView 会把中文按单字切），会出现「代码」这类词
 * 搜不到、「小水怪」误命中只含「小」「水」「怪」单字页面的问题。
 *
 * 搜索页在动态 import pagefind.js 之前调用 installSearchQuerySegmenter()：
 * 加载 scripts/build-search-vocab.mjs 从索引里抽出的词表，用「中文最长匹配」替换中文
 * 切词口径，让查询与索引使用同一套词。词表缺失或加载失败时静默退回浏览器原生切词，
 * 不影响搜索可用性。
 */

const HAN = /\p{Script=Han}/u;
const VOCAB_PATH = 'pagefind/vocab.zh.txt';

type SegmenterCtor = typeof Intl.Segmenter;

/**
 * 用词表做中文最长匹配，其余情况委托原生 Segmenter。
 * @param vocab 索引里真实存在的词（两字及以上的纯中文）
 * @param NativeSegmenter 浏览器原生 Intl.Segmenter（替换前的实现）
 */
export function createVocabSegmenter(
  vocab: Iterable<string>,
  NativeSegmenter: SegmenterCtor,
): SegmenterCtor {
  const words = new Set(vocab);
  let maxLen = 1;
  for (const word of words) maxLen = Math.max(maxLen, word.length);

  function VocabSegmenter(
    this: { native: Intl.Segmenter; options: Intl.SegmenterOptions },
    locale?: string | string[],
    options?: Intl.SegmenterOptions,
  ): void {
    this.native = new NativeSegmenter(locale, options);
    this.options = options ?? {};
  }

  VocabSegmenter.prototype.segment = function* (
    this: { native: Intl.Segmenter; options: Intl.SegmenterOptions },
    input: string,
  ): Generator<Intl.SegmentData> {
    // 只接管中文 word 级切词，其它粒度（grapheme/sentence）保持原样。
    if (this.options.granularity !== 'word') {
      yield* this.native.segment(input);
      return;
    }
    let index = 0;
    while (index < input.length) {
      if (!HAN.test(input[index]!)) {
        let end = index + 1;
        while (end < input.length && !HAN.test(input[end]!)) end += 1;
        yield* this.native.segment(input.slice(index, end));
        index = end;
        continue;
      }
      let end = index;
      while (end < input.length && HAN.test(input[end]!)) end += 1;
      const run = input.slice(index, end);
      for (let offset = 0; offset < run.length; ) {
        let matched = '';
        const longest = Math.min(maxLen, run.length - offset);
        for (let length = longest; length >= 2; length -= 1) {
          const candidate = run.slice(offset, offset + length);
          if (words.has(candidate)) {
            matched = candidate;
            break;
          }
        }
        if (!matched) matched = run[offset]!;
        yield { segment: matched, index: index + offset, input, isWordLike: true } as Intl.SegmentData;
        offset += matched.length;
      }
      index = end;
    }
  };

  VocabSegmenter.prototype.resolvedOptions = function (this: { native: Intl.Segmenter }): unknown {
    return this.native.resolvedOptions();
  };

  return VocabSegmenter as unknown as SegmenterCtor;
}

let installed = false;

export function isQuerySegmenterInstalled(): boolean {
  return installed;
}

/**
 * 加载词表并替换全局 Intl.Segmenter；返回是否替换成功。
 * 必须在 import pagefind.js 之前调用。失败不抛错，交给原生切词。
 */
export async function installSearchQuerySegmenter(): Promise<boolean> {
  if (installed) return true;
  const intl = Intl as unknown as { Segmenter?: SegmenterCtor };
  if (typeof intl.Segmenter !== 'function' || typeof fetch !== 'function') return false;

  let words: Set<string>;
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${VOCAB_PATH}`, { cache: 'no-cache' });
    if (!response.ok) return false;
    const lines = (await response.text())
      .split('\n')
      .map((word) => word.trim())
      .filter(Boolean);
    if (lines.length === 0) return false;
    words = new Set(lines);
  } catch {
    return false;
  }

  if (!intl.Segmenter) return false;
  intl.Segmenter = createVocabSegmenter(words, intl.Segmenter);
  installed = true;
  return true;
}
