/**
 * 日记内页的打字重演：全文先以浅色排出，再按全拼按键的节奏逐词显影。
 * 显影只改颜色与同宽字形，文档高度始终等于最终排版高度。
 */
import type { TypingLexicon } from '../lib/typing-data';

type TokenKind = 'han' | 'plain' | 'space' | 'atomic';
type UnitKind = 'word' | 'han' | 'plain' | 'space' | 'atomic';
type CandidatePace = 'quick' | 'normal' | 'slow';

interface Token {
  el: HTMLElement;
  text: string;
  kind: TokenKind;
  pinyin: string;
  block: Element | null;
  link: HTMLAnchorElement | null;
  done: boolean;
}

interface Unit {
  kind: UnitKind;
  tokens: Token[];
  text: string;
  syllables: string[];
  pinyin: string;
  done: boolean;
}

interface TimerEntry {
  id: number;
  resolve: () => void;
}

interface TypingScript {
  c: Record<string, string>;
  w: Record<string, string[]>;
  s: Record<string, string>;
}

const SESSION_PREFIX = 'moxo:diary-input:v1:';
const HAN = /\p{Script=Han}/u;
const SENSITIVE = /[鱼魚🐟🐠🐡]/u;
const SYLLABLE = /^[a-z]+$/;
const PUNCT = /[，。！？；：、,.!?;:…]/;
const END_PUNCT = /[。！？!?…]/;
const PAUSE_PUNCT = /[，、；：,;:]/;
const ATOMIC_SELECTOR =
  '.redact, img, video, audio, iframe, canvas, svg, pre, table, hr, figure, br, picture, object, embed';

/** 在原 156 键/分的基础上加快 40%：基准 350 → 250ms，连击下限 262 → 187ms。 */
const KEY_BASE = 250;
const KEY_MIN = 187;
const KEY_MAX = 1100;
const SYLLABLE_FIRST = 1.08;
const SYLLABLE_MIDDLE = 0.93;
const SYLLABLE_LAST = 0.98;
const SYLLABLE_GAP: readonly [number, number] = [18, 58];
const HESITATE_CHANCE = 0.025;
const HESITATE_PAUSE: readonly [number, number] = [240, 620];

const BACKSPACE_PAUSE: readonly [number, number] = [88, 160];
/** 键速提高后按比例降低滑键率，保持退格约 20 次/分不变。 */
const SLIP_CHANCE = 0.072;
const LATE_SLIP_CHANCE = 0.5;
const MAX_SLIPS_PER_SYLLABLE = 2;
const WORD_MISTAKE_CHANCE = 0.04;
const HAN_MISTAKE_CHANCE = 0.02;

const CANDIDATE_READ: readonly [number, number] = [160, 480];
const CANDIDATE_STEP: readonly [number, number] = [90, 180];
const CANDIDATE_SETTLE: readonly [number, number] = [90, 210];
const QUICK_READ: readonly [number, number] = [50, 170];
const QUICK_STEP: readonly [number, number] = [70, 130];
const QUICK_SETTLE: readonly [number, number] = [30, 100];
const SLOW_READ: readonly [number, number] = [360, 860];
const SLOW_STEP: readonly [number, number] = [110, 220];
const SLOW_SETTLE: readonly [number, number] = [140, 300];
const SLOW_LONG_CHANCE = 0.18;
const SLOW_LONG: readonly [number, number] = [700, 1500];

const COMMIT_PAUSE: readonly [number, number] = [130, 280];
const WORD_GAP: readonly [number, number] = [110, 300];
const CHAR_GAP: readonly [number, number] = [70, 200];
const PLAIN_KEY: readonly [number, number] = [160, 340];
const PUNCT_KEY: readonly [number, number] = [180, 360];
const END_REST: readonly [number, number] = [260, 620];
const PAUSE_REST: readonly [number, number] = [100, 300];
const ATOMIC_PAUSE: readonly [number, number] = [140, 300];
const BLOCK_PAUSE: readonly [number, number] = [600, 1300];
const THINK_PAUSE: readonly [number, number] = [300, 850];
const THINK_CHANCE = 0.03;
const NOTICE_PAUSE: readonly [number, number] = [500, 1100];
const DELETE_PAUSE: readonly [number, number] = [110, 210];

const WORD_UNIT_CHANCE = 0.88;
const MAX_WORD_UNIT = 4;

/** 收尾的余韵：光标再闪三次。周期取自 .diary-caret 的 1.08s 动画。 */
const CARET_BLINK_PERIOD = 1080;
const CARET_BLINKS = 3;
/** 熄灭落在最后一次暗相结束前，免得又亮一下才消失。 */
const CARET_EXIT_EDGE = 220;

const KEYBOARD_NEIGHBORS: Record<string, string> = {
  a: 'qwsz',
  b: 'vghn',
  c: 'xdfv',
  d: 'serfcx',
  e: 'wsdr',
  f: 'drtgvc',
  g: 'ftyhbv',
  h: 'gyujnb',
  i: 'ujko',
  j: 'huiknm',
  k: 'jiolm',
  l: 'kop',
  m: 'njk',
  n: 'bhjm',
  o: 'ikpl',
  p: 'ol',
  q: 'was',
  r: 'edft',
  s: 'awedxz',
  t: 'rfgy',
  u: 'yhij',
  v: 'cfgb',
  w: 'qeasd',
  x: 'zsdc',
  y: 'tghu',
  z: 'asx',
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const pick = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

function splitGraphemes(value: string): string[] {
  if (!graphemes) return Array.from(value);
  return Array.from(graphemes.segment(value), ({ segment }) => segment);
}

function shuffle<T>(items: T[]): T[] {
  const list = items.slice();
  for (let index = list.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [list[index], list[next]] = [list[next], list[index]];
  }
  return list;
}

function sampleTempo(): number {
  const roll = Math.random();
  if (roll < 0.3) return 0.8 + Math.random() * 0.13;
  if (roll < 0.78) return 0.94 + Math.random() * 0.14;
  return 1.14 + Math.random() * 0.3;
}

function neighborLetter(letter: string): string {
  const options = KEYBOARD_NEIGHBORS[letter];
  if (!options) return 'x';
  return options[Math.floor(Math.random() * options.length)];
}

function parseLexicon(host: HTMLElement): TypingLexicon | null {
  const script = host.querySelector<HTMLScriptElement>('[data-diary-typing-lexicon]');
  if (!script?.textContent) return null;

  try {
    const parsed = JSON.parse(script.textContent) as TypingScript;
    if (!parsed || typeof parsed.c !== 'object' || typeof parsed.s !== 'object') return null;
    if (typeof parsed.w !== 'object') parsed.w = {};
    return parsed;
  } catch {
    return null;
  }
}

class DiaryTyping {
  private readonly host: HTMLElement;
  private readonly source: HTMLElement;
  private readonly skipButton: HTMLButtonElement | null;
  private readonly slug: string;
  private readonly lexicon: TypingLexicon | null;
  private readonly reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  private tokens: Token[] = [];
  private units: Unit[] = [];
  private syllableEntries: Array<[string, string]> = [];
  private prefixPools = new Map<string, string[]>();
  private wordStarts = new Map<string, Array<{ chars: string; syllables: string[] }>>();
  private wordIndex = new Map<string, string[]>();
  private fallbackPool: string[] | null = null;

  private caret: HTMLDivElement | null = null;
  private caretToken: Token | null = null;
  private caretBefore = true;
  private panel: HTMLDivElement | null = null;
  private panelCompose: HTMLElement | null = null;
  private panelList: HTMLElement | null = null;
  private panelWanted = false;

  private timers = new Set<TimerEntry>();
  private viewportFrame = 0;
  private stopped = true;
  private state: 'idle' | 'running' | 'done' | 'destroyed' = 'idle';
  private lastBlock: Element | null = null;
  private typedAny = false;

  constructor(host: HTMLElement) {
    const source = host.querySelector<HTMLElement>('[data-diary-typing-source]');
    if (!source) throw new Error('diary typing markup is incomplete');

    this.host = host;
    this.source = source;
    this.skipButton = host.querySelector<HTMLButtonElement>('[data-diary-typing-skip]');
    this.slug = host.dataset.diarySlug ?? 'unknown';
    this.lexicon = parseLexicon(host);
  }

  async init(): Promise<void> {
    if (this.host.dataset.typingState === 'done') return;
    if (!this.lexicon || this.reduceQuery.matches || this.seen()) {
      this.revealOnly();
      return;
    }

    let tokens: Token[];
    try {
      tokens = this.prepare();
    } catch {
      this.revealOnly();
      return;
    }

    if (tokens.length === 0) {
      this.revealOnly();
      return;
    }

    this.state = 'running';
    this.stopped = false;
    this.host.dataset.typingState = 'typing';
    this.bindEvents();
    this.markSeen();
    this.afterStart();

    try {
      await this.wait(420);
      if (this.stopped) return;

      await this.runTyped();
      if (!this.stopped) this.finish();
    } catch {
      if (!this.stopped) this.finish();
    }
  }

  private prepare(): Token[] {
    this.buildTokens(this.source);
    this.dimLinks();
    this.createOverlay();
    this.assignPinyin();
    this.buildUnits();
    this.host.dataset.typingReady = 'true';
    return this.tokens;
  }

  private buildTokens(root: HTMLElement): void {
    const walk = (parent: ParentNode): void => {
      for (const child of Array.from(parent.childNodes)) {
        if (child instanceof Text) {
          this.splitTextNode(child);
        } else if (child instanceof HTMLElement) {
          if (child.matches(ATOMIC_SELECTOR)) {
            const token: Token = {
              el: child,
              text: '',
              kind: 'atomic',
              pinyin: '',
              block: child.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, th, td'),
              link: null,
              done: false,
            };
            child.classList.add('diary-typing-atomic', 'is-pending');
            this.tokens.push(token);
          } else {
            walk(child);
          }
        }
      }
    };

    walk(root);
  }

  private splitTextNode(node: Text): void {
    const value = node.data;
    if (!value) return;

    const block =
      node.parentElement?.closest(
        'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, th, td',
      ) ?? null;
    const link = node.parentElement?.closest('a') ?? null;

    const fragment = document.createDocumentFragment();
    for (const grapheme of splitGraphemes(value)) {
      const span = document.createElement('span');
      span.className = 'diary-typing-token';
      span.textContent = grapheme;
      const isSpace = /^\s+$/u.test(grapheme);
      if (!isSpace) span.classList.add('is-pending');

      const kind: TokenKind = isSpace ? 'space' : HAN.test(grapheme) ? 'han' : 'plain';
      const token: Token = {
        el: span,
        text: grapheme,
        kind,
        pinyin: '',
        block,
        link,
        done: isSpace,
      };
      this.tokens.push(token);
      fragment.append(span);
    }

    node.replaceWith(fragment);
  }

  private dimLinks(): void {
    for (const token of this.tokens) token.link?.classList.add('is-pending');
  }

  private releaseLink(token: Token): void {
    const link = token.link;
    if (!link) return;
    if (!link.querySelector('.is-pending')) link.classList.remove('is-pending');
  }

  private createOverlay(): void {
    this.caret = document.createElement('div');
    this.caret.className = 'diary-caret';
    this.caret.setAttribute('aria-hidden', 'true');
    this.caret.style.display = 'none';
    document.body.append(this.caret);

    const panel = document.createElement('div');
    panel.className = 'diary-ime';
    panel.setAttribute('aria-hidden', 'true');
    const head = document.createElement('div');
    head.className = 'diary-ime-head';
    const compose = document.createElement('span');
    compose.className = 'diary-ime-compose';
    const mode = document.createElement('span');
    mode.className = 'diary-ime-mode';
    mode.textContent = '全拼';
    head.append(compose, mode);
    const list = document.createElement('div');
    list.className = 'diary-ime-list';
    panel.append(head, list);
    document.body.append(panel);
    this.panel = panel;
    this.panelCompose = compose;
    this.panelList = list;
  }

  private assignPinyin(): void {
    this.wordStarts.clear();
    this.wordIndex.clear();

    for (const [word, syllables] of Object.entries(this.lexicon?.w ?? {})) {
      if (!syllables.length || !syllables.every((item) => SYLLABLE.test(item))) continue;
      const chars = splitGraphemes(word);
      if (chars.length !== syllables.length) continue;
      if (!chars.every((char) => HAN.test(char)) || SENSITIVE.test(word)) continue;

      const list = this.wordStarts.get(chars[0]) ?? [];
      list.push({ chars: word, syllables });
      this.wordStarts.set(chars[0], list);

      const signature = syllables.join('|');
      const bucket = this.wordIndex.get(signature) ?? [];
      bucket.push(word);
      this.wordIndex.set(signature, bucket);
    }

    for (const list of this.wordStarts.values()) {
      list.sort((a, b) => b.chars.length - a.chars.length);
    }

    let index = 0;
    while (index < this.tokens.length) {
      const token = this.tokens[index];
      if (token.kind !== 'han') {
        index += 1;
        continue;
      }

      const matches = this.wordStarts.get(token.text) ?? [];
      let consumed = 0;
      for (const word of matches) {
        const chars = splitGraphemes(word.chars);
        if (index + chars.length > this.tokens.length) continue;
        const fits = chars.every((char, offset) => {
          const next = this.tokens[index + offset];
          return next.kind === 'han' && next.text === char;
        });
        if (!fits) continue;

        chars.forEach((_char, offset) => {
          this.tokens[index + offset].pinyin = word.syllables[offset];
        });
        consumed = chars.length;
        break;
      }

      if (consumed === 0) {
        const syllable = this.lexicon?.c[token.text] ?? '';
        token.pinyin = SYLLABLE.test(syllable) ? syllable : '';
        consumed = 1;
      }
      index += consumed;
    }

    this.syllableEntries = Object.entries(this.lexicon?.s ?? {});
  }

  private buildUnits(): void {
    this.units = [];
    let index = 0;

    while (index < this.tokens.length) {
      const token = this.tokens[index];
      if (token.done) {
        index += 1;
        continue;
      }

      if (token.kind === 'han' && token.pinyin) {
        const length =
          Math.random() < WORD_UNIT_CHANCE ? this.matchWordLength(index) : 0;

        if (length > 1) {
          const wordTokens = this.tokens.slice(index, index + length);
          this.units.push({
            kind: 'word',
            tokens: wordTokens,
            text: wordTokens.map((item) => item.text).join(''),
            syllables: wordTokens.map((item) => item.pinyin),
            pinyin: wordTokens.map((item) => item.pinyin).join(''),
            done: false,
          });
          index += length;
          continue;
        }

        this.units.push({
          kind: 'han',
          tokens: [token],
          text: token.text,
          syllables: [token.pinyin],
          pinyin: token.pinyin,
          done: false,
        });
        index += 1;
        continue;
      }

      this.units.push({
        kind: token.kind === 'atomic' ? 'atomic' : 'plain',
        tokens: [token],
        text: token.text,
        syllables: [],
        pinyin: '',
        done: false,
      });
      index += 1;
    }
  }

  private matchWordLength(start: number): number {
    const token = this.tokens[start];
    const matches = this.wordStarts.get(token.text) ?? [];

    for (const word of matches) {
      const chars = splitGraphemes(word.chars);
      if (chars.length < 2 || chars.length > MAX_WORD_UNIT) continue;
      if (start + chars.length > this.tokens.length) continue;

      const fits = chars.every((char, offset) => {
        const next = this.tokens[start + offset];
        return next.kind === 'han' && next.text === char && Boolean(next.pinyin);
      });
      if (fits) return chars.length;
    }
    return 0;
  }

  private exactPool(pinyin: string): string[] {
    return Array.from(this.lexicon?.s[pinyin] ?? '').filter((char) => !SENSITIVE.test(char));
  }

  private prefixPool(prefix: string): string[] {
    const cached = this.prefixPools.get(prefix);
    if (cached) return cached;

    const chars = new Set<string>();
    for (const [syllable, pool] of this.syllableEntries) {
      if (!syllable.startsWith(prefix)) continue;
      for (const char of pool) {
        if (!SENSITIVE.test(char)) chars.add(char);
      }
    }
    const result = Array.from(chars);
    this.prefixPools.set(prefix, result);
    return result;
  }

  private anyChars(): string[] {
    if (this.fallbackPool) return this.fallbackPool;
    const chars = new Set<string>();
    for (const [, pool] of this.syllableEntries) {
      for (const char of pool) {
        if (!SENSITIVE.test(char)) chars.add(char);
      }
    }
    this.fallbackPool = Array.from(chars);
    return this.fallbackPool;
  }

  private candidatePosition(count: number, zeroBias: number): number {
    if (count <= 1) return 0;
    const roll = Math.random();
    if (roll < zeroBias) return 0;
    if (roll < zeroBias + 0.23) return Math.min(1, count - 1);
    if (roll < zeroBias + 0.4) return Math.min(2, count - 1);
    if (roll < zeroBias + 0.52) return Math.min(3, count - 1);
    return Math.min(count - 1, 4);
  }

  private insertTarget(others: string[], target: string, zeroBias: number): string[] {
    if (SENSITIVE.test(target)) return others;
    const list = others.slice();
    const position = this.candidatePosition(list.length + 1, zeroBias);
    list.splice(position, 0, target);
    return list;
  }

  private charCandidates(syllable: string, target: string, zeroBias: number): string[] {
    const others = shuffle(
      this.exactPool(syllable).filter((char) => char !== target),
    ).slice(0, 4);
    return this.insertTarget(others, target, zeroBias);
  }

  private wordCandidates(unit: Unit, target: string, zeroBias: number): string[] {
    const signature = unit.syllables.join('|');
    const length = unit.tokens.length;
    const same = this.wordIndex.get(signature) ?? [];
    const exact = shuffle(
      same.filter(
        (word) =>
          word !== target && splitGraphemes(word).length === length && !SENSITIVE.test(word),
      ),
    ).slice(0, 4);

    const others = exact.slice();
    let guard = 0;
    while (others.length < 4 && guard < 16) {
      guard += 1;
      const synthetic = this.syntheticWord(unit.syllables);
      if (!synthetic || synthetic === target || others.includes(synthetic)) continue;
      others.push(synthetic);
    }

    return this.insertTarget(others, target, zeroBias);
  }

  private syntheticWord(syllables: string[]): string | null {
    let word = '';
    for (const syllable of syllables) {
      const pool = this.exactPool(syllable);
      if (pool.length === 0) return null;
      word += pool[Math.floor(Math.random() * pool.length)];
    }
    return splitGraphemes(word).length === syllables.length ? word : null;
  }

  private pickWrongCandidate(candidates: string[], target: string): string | null {
    const options = candidates.filter((item) => item !== target && !SENSITIVE.test(item));
    if (options.length === 0) return null;
    return options[Math.floor(Math.random() * options.length)];
  }

  private candidatePace(word: boolean): CandidatePace {
    const roll = Math.random();
    if (word) return roll < 0.22 ? 'quick' : roll < 0.72 ? 'normal' : 'slow';
    return roll < 0.55 ? 'quick' : roll < 0.87 ? 'normal' : 'slow';
  }

  private renderPanel(composition: string, candidates: string[], active: number): void {
    if (!this.panel || !this.panelCompose || !this.panelList) return;

    this.panelCompose.textContent = composition;
    const fragment = document.createDocumentFragment();
    candidates.forEach((candidate, index) => {
      const item = document.createElement('span');
      item.className = 'diary-ime-item';
      if (index === active) item.classList.add('is-active');
      const number = document.createElement('span');
      number.className = 'diary-ime-index';
      number.textContent = String(index + 1);
      const glyph = document.createElement('span');
      glyph.className = 'diary-ime-glyph';
      glyph.textContent = candidate;
      item.append(number, glyph);
      fragment.append(item);
    });
    this.panelList.replaceChildren(fragment);
    this.panelWanted = true;
    this.panel.classList.add('is-visible');
  }

  private composeLabel(unit: Unit, raw: string): string {
    if (unit.syllables.length < 2) return raw;

    const parts: string[] = [];
    let offset = 0;
    for (const syllable of unit.syllables) {
      if (offset >= raw.length) break;
      const end = Math.min(raw.length, offset + syllable.length);
      parts.push(raw.slice(offset, end));
      offset = end;
    }
    if (offset < raw.length) parts.push(raw.slice(offset));
    return parts.join("'");
  }

  private syllableAt(unit: Unit, raw: string): { index: number; prefix: string } {
    let offset = 0;
    for (let index = 0; index < unit.syllables.length; index += 1) {
      const length = unit.syllables[index].length;
      if (raw.length < offset + length) {
        return { index, prefix: raw.slice(offset) };
      }
      offset += length;
    }
    const last = unit.syllables.length - 1;
    return { index: last, prefix: unit.syllables[last] ?? '' };
  }

  private renderPartial(unit: Unit, composition: string): void {
    if (!composition) {
      this.hidePanel();
      return;
    }

    const { index, prefix } = this.syllableAt(unit, composition);
    if (!prefix) return;

    const target = unit.tokens[Math.min(index, unit.tokens.length - 1)]?.text ?? '';
    const source = this.prefixPool(prefix);
    const pool = source.length > 0 ? source : this.anyChars();
    const candidates = shuffle(pool.filter((char) => char !== target)).slice(0, 5);
    this.renderPanel(
      this.composeLabel(unit, composition),
      candidates,
      candidates.length > 0 ? 0 : -1,
    );
  }

  private hidePanel(): void {
    this.panelWanted = false;
    this.panel?.classList.remove('is-visible');
    if (this.panelCompose) this.panelCompose.textContent = '';
  }

  private async runTyped(): Promise<void> {
    let index = 0;

    while (index < this.units.length) {
      if (this.stopped) return;
      const unit = this.units[index];
      if (unit.done) {
        index += 1;
        continue;
      }

      await this.enterUnit(unit);
      if (this.stopped) return;

      const result = await this.typeUnit(unit, true);
      if (this.stopped) return;

      if (result === 'wrong') {
        const last = await this.typeFollowing(index);
        if (this.stopped) return;

        await this.fixWrong(unit);
        if (this.stopped) return;

        unit.done = true;
        index = Math.max(index, last) + 1;
        continue;
      }

      unit.done = true;
      index += 1;
    }

    this.hidePanel();
    await this.retireCaret();
  }

  /** 打字停下后光标再闪三次才消失：相位重新起算，熄在暗相里，不跳变。 */
  private async retireCaret(): Promise<void> {
    const caret = this.caret;
    if (!caret || caret.style.display === 'none') return;

    // 从亮相重新计时，三次不随打字时长的相位漂移。
    caret.style.animation = 'none';
    void caret.offsetWidth;
    caret.style.animation = '';

    await this.wait(CARET_BLINK_PERIOD * CARET_BLINKS - CARET_EXIT_EDGE);
    if (this.stopped) return;

    this.hideCaret();
  }

  private async enterUnit(unit: Unit): Promise<void> {
    const block = unit.tokens[0]?.block ?? null;
    if (block && block !== this.lastBlock && this.typedAny && unit.kind !== 'space') {
      this.lastBlock = block;
      await this.wait(pick(BLOCK_PAUSE));
    } else if (block) {
      this.lastBlock = block;
    }
    this.typedAny = true;
  }

  private async typeFollowing(start: number): Promise<number> {
    let han = 0;
    let last = start;

    for (let index = start + 1; index < this.units.length && han < 2; index += 1) {
      if (this.stopped) return last;
      const unit = this.units[index];
      if (unit.done || unit.kind === 'space') continue;

      await this.enterUnit(unit);
      if (this.stopped) return last;

      await this.typeUnit(unit, false);
      if (this.stopped) return last;

      unit.done = true;
      last = index;
      han += unit.tokens.filter((token) => token.kind === 'han').length;
    }

    return last;
  }

  private async typeUnit(unit: Unit, allowMistake: boolean): Promise<'ok' | 'wrong'> {
    if (this.stopped) return 'ok';

    if (unit.kind === 'atomic') {
      unit.tokens[0].el.classList.remove('is-pending');
      await this.wait(pick(ATOMIC_PAUSE));
      return 'ok';
    }

    if (unit.kind === 'plain') {
      return this.typePlain(unit);
    }

    if (unit.kind === 'han' && !unit.pinyin) {
      const token = unit.tokens[0];
      token.el.classList.remove('is-pending');
      this.setCaret(token, false);
      this.releaseLink(token);
      await this.wait(pick(PLAIN_KEY));
      return 'ok';
    }

    return this.typeComposed(unit, allowMistake);
  }

  private async typePlain(unit: Unit): Promise<'ok'> {
    const token = unit.tokens[0];
    token.el.classList.remove('is-pending');
    this.setCaret(token, true);
    this.releaseLink(token);

    if (token.kind === 'space') return 'ok';

    await this.wait(pick(PUNCT.test(token.text) ? PUNCT_KEY : PLAIN_KEY));
    if (this.stopped) return 'ok';

    if (END_PUNCT.test(token.text)) {
      await this.wait(pick(END_REST));
    } else if (PAUSE_PUNCT.test(token.text)) {
      await this.wait(pick(PAUSE_REST));
    }

    return 'ok';
  }

  private async typeComposed(unit: Unit, allowMistake: boolean): Promise<'ok' | 'wrong'> {
    if (this.stopped) return 'ok';

    const composition = { value: '' };
    const tempo = sampleTempo();
    this.setCaret(unit.tokens[0], false);

    for (let index = 0; index < unit.syllables.length; index += 1) {
      await this.typeSyllable(unit.syllables[index], unit, tempo, composition);
      if (this.stopped) return 'ok';

      const token = unit.tokens[Math.min(index, unit.tokens.length - 1)];
      token.el.classList.add('is-composing');

      if (index < unit.syllables.length - 1) {
        await this.wait(pick(SYLLABLE_GAP));
        if (this.stopped) return 'ok';
      }
    }

    const target = unit.text;
    const pace = this.candidatePace(unit.kind === 'word');
    const zeroBias =
      pace === 'quick' ? 0.72 : pace === 'slow' ? 0.16 : unit.kind === 'word' ? 0.34 : 0.46;
    const candidates =
      unit.kind === 'word'
        ? this.wordCandidates(unit, target, zeroBias)
        : this.charCandidates(unit.pinyin, target, zeroBias);

    let commit = target;
    let active = candidates.indexOf(target);

    if (allowMistake && Math.random() < (unit.kind === 'word' ? WORD_MISTAKE_CHANCE : HAN_MISTAKE_CHANCE)) {
      const wrong = this.pickWrongCandidate(candidates, target);
      if (wrong) {
        commit = wrong;
        active = candidates.indexOf(wrong);
      }
    }

    if (active < 0) {
      active = candidates.length > 0 ? Math.floor(Math.random() * candidates.length) : 0;
    }

    await this.chooseCandidate(this.composeLabel(unit, unit.pinyin), candidates, active, pace);
    if (this.stopped) return 'ok';

    this.applyCommit(unit, commit);
    this.hidePanel();
    this.setCaret(unit.tokens[unit.tokens.length - 1], true);

    const wrong = commit !== target;
    if (wrong) {
      for (const token of unit.tokens) token.el.classList.add('is-typo');
    }

    await this.wait(pick(COMMIT_PAUSE));
    if (this.stopped) return 'ok';

    await this.wait(pick(unit.kind === 'word' ? WORD_GAP : CHAR_GAP));
    if (this.stopped) return 'ok';

    if (!wrong && Math.random() < THINK_CHANCE) {
      await this.wait(pick(THINK_PAUSE));
    }

    return wrong ? 'wrong' : 'ok';
  }

  private keyDelay(tempo: number, position: number, count: number, wrong: boolean): number {
    let factor = tempo * (wrong ? 1.06 : 1);
    if (count > 1) {
      if (position === 0) factor *= SYLLABLE_FIRST;
      else if (position === count - 1) factor *= SYLLABLE_LAST;
      else factor *= SYLLABLE_MIDDLE;
    }

    let delay = KEY_BASE * factor * (0.9 + Math.random() * 0.2);
    if (Math.random() < HESITATE_CHANCE) delay += pick(HESITATE_PAUSE);
    return clamp(delay, KEY_MIN, KEY_MAX);
  }

  private async pressKey(
    letter: string,
    unit: Unit,
    composition: { value: string },
    tempo: number,
    position: number,
    count: number,
    wrong: boolean,
  ): Promise<void> {
    composition.value += letter;
    this.renderPartial(unit, composition.value);
    this.syncOverlay();
    await this.wait(this.keyDelay(tempo, position, count, wrong));
  }

  private async backspace(unit: Unit, composition: { value: string }): Promise<void> {
    if (!composition.value) return;
    composition.value = composition.value.slice(0, -1);
    if (composition.value) this.renderPartial(unit, composition.value);
    else this.hidePanel();
    this.syncOverlay();
    await this.wait(pick(BACKSPACE_PAUSE));
  }

  private async typeSyllable(
    syllable: string,
    unit: Unit,
    tempo: number,
    composition: { value: string },
  ): Promise<void> {
    const letters = splitGraphemes(syllable);
    let index = 0;
    let slips = 0;

    while (index < letters.length) {
      if (this.stopped) return;

      if (slips < MAX_SLIPS_PER_SYLLABLE && Math.random() < SLIP_CHANCE) {
        slips += 1;
        await this.pressKey(
          neighborLetter(letters[index]),
          unit,
          composition,
          tempo,
          index,
          letters.length,
          true,
        );
        if (this.stopped) return;

        const late = Math.random() < LATE_SLIP_CHANCE && index < letters.length - 1;
        if (late) {
          const room = letters.length - index - 1;
          const extra = Math.min(room, 1 + Math.floor(Math.random() * 2));
          for (let step = 0; step < extra; step += 1) {
            await this.pressKey(
              letters[index + step],
              unit,
              composition,
              tempo,
              index + step,
              letters.length,
              false,
            );
            if (this.stopped) return;
          }
          for (let step = 0; step < extra + 1; step += 1) {
            await this.backspace(unit, composition);
            if (this.stopped) return;
          }
          continue;
        }

        await this.backspace(unit, composition);
        if (this.stopped) return;
        continue;
      }

      await this.pressKey(
        letters[index],
        unit,
        composition,
        tempo,
        index,
        letters.length,
        false,
      );
      if (this.stopped) return;
      index += 1;
    }
  }

  private async chooseCandidate(
    composition: string,
    candidates: string[],
    target: number,
    pace: CandidatePace,
  ): Promise<void> {
    const read = pace === 'quick' ? QUICK_READ : pace === 'slow' ? SLOW_READ : CANDIDATE_READ;
    const step = pace === 'quick' ? QUICK_STEP : pace === 'slow' ? SLOW_STEP : CANDIDATE_STEP;
    const settle =
      pace === 'quick' ? QUICK_SETTLE : pace === 'slow' ? SLOW_SETTLE : CANDIDATE_SETTLE;
    const overshootChance = pace === 'quick' ? 0 : pace === 'slow' ? 0.28 : 0.14;

    this.renderPanel(composition, candidates, 0);
    this.syncOverlay();

    await this.wait(pick(read));
    if (this.stopped) return;

    if (pace === 'slow' && Math.random() < SLOW_LONG_CHANCE) {
      await this.wait(pick(SLOW_LONG));
      if (this.stopped) return;
    }

    let active = 0;
    const overshoot =
      target > 0 && target < candidates.length - 1 && Math.random() < overshootChance;
    const end = overshoot ? target + 1 : target;

    while (active < end) {
      active += 1;
      this.renderPanel(composition, candidates, active);
      this.syncOverlay();
      await this.wait(pick(step));
      if (this.stopped) return;
    }

    if (overshoot) {
      this.renderPanel(composition, candidates, target);
      this.syncOverlay();
      await this.wait(pick(step));
      if (this.stopped) return;
    }

    await this.wait(pick(settle));
  }

  private applyCommit(unit: Unit, text: string): void {
    const chars = splitGraphemes(text);
    unit.tokens.forEach((token, index) => {
      token.el.textContent = chars[index] ?? token.text;
      token.el.classList.remove('is-composing', 'is-pending', 'is-typo', 'is-deleting');
    });
    for (const token of unit.tokens) this.releaseLink(token);
  }

  private async fixWrong(unit: Unit): Promise<void> {
    for (const token of unit.tokens) token.el.classList.add('is-typo');

    await this.wait(pick(NOTICE_PAUSE));
    if (this.stopped) return;

    for (let index = unit.tokens.length - 1; index >= 0; index -= 1) {
      const token = unit.tokens[index];
      this.setCaret(token, false);
      token.el.classList.add('is-deleting');

      await this.wait(pick(DELETE_PAUSE));
      if (this.stopped) return;

      token.el.textContent = token.text;
      token.el.classList.remove('is-typo', 'is-deleting');
      token.el.classList.add('is-pending');
      token.link?.classList.add('is-pending');

      await this.wait(pick(BACKSPACE_PAUSE));
      if (this.stopped) return;
    }

    await this.typeComposed(unit, false);
  }

  private setCaret(token: Token, after: boolean): void {
    this.caretToken = token;
    this.caretBefore = !after;
    if (this.caret) this.caret.style.display = '';
    this.syncOverlay();
  }

  private hideCaret(): void {
    if (this.caret) this.caret.style.display = 'none';
  }

  private syncOverlay = (): void => {
    const token = this.caretToken;
    if (!token?.el.isConnected) return;

    const rect = token.el.getBoundingClientRect();
    const edge = this.caretBefore ? rect.left : rect.right;
    const inView = rect.bottom > 2 && rect.top < window.innerHeight - 2;

    if (this.caret) {
      if (!inView) {
        this.caret.style.display = 'none';
      } else {
        const fontSize = Number.parseFloat(getComputedStyle(token.el).fontSize) || 18;
        const height = clamp(fontSize * 1.3, 14, 30);
        const top = rect.top + (rect.height - height) / 2;
        this.caret.style.display = '';
        this.caret.style.transform = `translate3d(${edge.toFixed(2)}px, ${top.toFixed(2)}px, 0)`;
        this.caret.style.height = `${height.toFixed(1)}px`;
      }
    }

    if (!this.panel) return;

    const visible = inView && this.panelWanted;
    this.panel.classList.toggle('is-visible', visible);
    if (!visible) return;

    const width = this.panel.offsetWidth;
    const height = this.panel.offsetHeight;
    let left = edge + 4;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    left = clamp(left, 12, Math.max(12, window.innerWidth - width - 12));

    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - 12) top = rect.top - height - 10;
    top = clamp(top, 8, Math.max(8, window.innerHeight - height - 8));

    this.panel.style.left = `${left.toFixed(1)}px`;
    this.panel.style.top = `${top.toFixed(1)}px`;
  };

  private onViewport = (): void => {
    if (this.viewportFrame) return;
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.syncOverlay();
    });
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.stopped) return;
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // 灯箱等顶层弹层开着时，ESC 归弹层（preventDefault 会掐断 dialog 的 cancel）
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      this.finish();
    }
  };

  private onSkip = (): void => {
    this.finish();
  };

  private onReduced = (): void => {
    if (this.reduceQuery.matches) this.finish();
  };

  private bindEvents(): void {
    this.skipButton?.addEventListener('click', this.onSkip);
    window.addEventListener('scroll', this.onViewport, { passive: true });
    window.addEventListener('resize', this.onViewport, { passive: true });
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.reduceQuery.addEventListener('change', this.onReduced);
    void document.fonts?.ready.then(() => this.syncOverlay());
  }

  private unbindEvents(): void {
    this.skipButton?.removeEventListener('click', this.onSkip);
    window.removeEventListener('scroll', this.onViewport);
    window.removeEventListener('resize', this.onViewport);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    this.reduceQuery.removeEventListener('change', this.onReduced);
  }

  private afterStart(): void {
    const first = this.tokens.find((token) => token.kind !== 'space');
    if (first) this.setCaret(first, false);
  }

  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();

    return new Promise((resolve) => {
      const entry: TimerEntry = { id: 0, resolve };
      entry.id = window.setTimeout(() => {
        this.timers.delete(entry);
        resolve();
      }, Math.max(0, Math.round(ms)));
      this.timers.add(entry);
    });
  }

  private cancelTimers(): void {
    for (const timer of this.timers) {
      window.clearTimeout(timer.id);
      timer.resolve();
    }
    this.timers.clear();
  }

  private seen(): boolean {
    try {
      return sessionStorage.getItem(`${SESSION_PREFIX}${this.slug}`) === '1';
    } catch {
      return false;
    }
  }

  private markSeen(): void {
    try {
      sessionStorage.setItem(`${SESSION_PREFIX}${this.slug}`, '1');
    } catch {
      /* 私密窗口禁用存储时就每次重播 */
    }
  }

  private revealAll(): void {
    for (const token of this.tokens) {
      token.el.classList.remove('is-pending', 'is-composing', 'is-typo', 'is-deleting');
      if (token.kind === 'han') token.el.textContent = token.text;
    }
    this.source.querySelectorAll('a.is-pending').forEach((link) => {
      link.classList.remove('is-pending');
    });
  }

  private removeOverlay(): void {
    this.caret?.remove();
    this.panel?.remove();
    this.caret = null;
    this.panel = null;
    this.panelCompose = null;
    this.panelList = null;
    this.caretToken = null;
  }

  private stop(): void {
    this.stopped = true;
    this.cancelTimers();
    cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = 0;
    this.unbindEvents();
  }

  private revealOnly(): void {
    this.state = 'done';
    this.stop();
    this.revealAll();
    this.removeOverlay();
    this.host.dataset.typingReady = 'true';
    this.host.dataset.typingState = 'done';
  }

  finish(): void {
    if (this.state === 'done' || this.state === 'destroyed') return;
    this.state = 'done';
    this.stop();
    this.revealAll();
    this.removeOverlay();
    this.host.dataset.typingState = 'done';
  }

  destroy(): void {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    this.stop();
    this.removeOverlay();
  }
}

let active: DiaryTyping | null = null;

function initDiaryTyping(): void {
  active?.destroy();
  active = null;

  const host = document.querySelector<HTMLElement>('[data-diary-typing]');
  if (!host || host.dataset.typingState === 'done') return;

  try {
    active = new DiaryTyping(host);
    void active.init();
  } catch {
    host.dataset.typingState = 'done';
  }
}

document.addEventListener('astro:page-load', initDiaryTyping);
document.addEventListener('moxo:diary-unlocked', initDiaryTyping);
document.addEventListener('astro:before-swap', () => {
  active?.destroy();
  active = null;
});
