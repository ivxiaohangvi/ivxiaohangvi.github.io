import type { WordFieldWord } from './word-field';

export interface CloudWord extends WordFieldWord {
  x: number;
  y: number;
  size: number;
  dur: number;
  delay: number;
  amp: number;
  lo: number;
}

export interface CloudLayout {
  width: number;
  height: number;
  words: CloudWord[];
}

export interface CloudLayoutOptions {
  width: number;
  height: number;
  sizes: Record<1 | 2 | 3 | 4, number>;
  padding?: number;
  gap?: number;
  seed?: number;
  ampScale?: number;
  /** Boundary exponent: 2 = ellipse, higher values square off the field. */
  shape?: number;
  /** 0 = place from the middle outward, 1 = each word searches around its own anchor. */
  spread?: number;
  /**
   * Per-tier territory as [inner, outer] fractions of the boundary radius.
   * Anchors are sampled inside the band, and placements may never sit deeper
   * than the inner edge. Overrides spread.
   */
  bands?: Partial<Record<1 | 2 | 3 | 4, [number, number]>>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function textWidth(word: string, size: number): number {
  let units = 0;
  for (const char of word) {
    if (/[\u2e80-\u9fff\uf900-\ufaff]/.test(char)) units += 1;
    else if (/[A-Z]/.test(char)) units += 0.68;
    else if (/[a-z]/.test(char)) units += 0.44;
    else if (/[0-9]/.test(char)) units += 0.5;
    else units += 0.3;
  }
  return units * size;
}

export function layoutWordCloud(words: WordFieldWord[], options: CloudLayoutOptions): CloudLayout {
  const {
    width,
    height,
    sizes,
    padding = 16,
    gap = 9,
    seed = 1,
    ampScale = 1,
    shape = 2,
    spread = 0,
    bands,
  } = options;
  const random = mulberry32(seed);
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2 - padding;
  const ry = height / 2 - padding;
  const boxes: Box[] = [];
  const placedWords: CloudWord[] = [];

  const radial = (x: number, y: number): number =>
    Math.pow(
      Math.abs((x - cx) / rx) ** shape + Math.abs((y - cy) / ry) ** shape,
      1 / shape,
    );

  const inside = (x: number, y: number, w: number, h: number): boolean => {
    const corners = [
      [x - w / 2, y - h / 2],
      [x + w / 2, y - h / 2],
      [x - w / 2, y + h / 2],
      [x + w / 2, y + h / 2],
    ];
    return corners.every(
      ([px, py]) =>
        Math.abs((px - cx) / rx) ** shape + Math.abs((py - cy) / ry) ** shape <= 1,
    );
  };

  const hits = (x: number, y: number, w: number, h: number, spacing: number): boolean =>
    boxes.some(
      (box) =>
        Math.abs(x - box.x) < (w + box.w) / 2 + spacing &&
        Math.abs(y - box.y) < (h + box.h) / 2 + spacing,
    );

  const sorted = [...words].sort(
    (a, b) =>
      sizes[b.tier] - sizes[a.tier] ||
      b.count - a.count ||
      a.word.localeCompare(b.word, 'zh-CN'),
  );

  for (const item of sorted) {
    const size = sizes[item.tier];
    const w = textWidth(item.word, size) + size * 0.14;
    const h = size * 1.12;
    const band = bands?.[item.tier];
    const floor = band?.[0] ?? 0;
    let position: { x: number; y: number } | null = null;
    let nearest = Infinity;
    let bestSpacing = -1;

    // Several anchor draws per word: the first free spot near any of them wins.
    // One draw alone lets crowded anchors fling words into an outer ring.
    const attempts = band ? 5 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let anchorX: number;
      let anchorY: number;
      if (band) {
        const angle = random() * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const reach =
          1 /
          Math.pow(
            Math.pow(Math.abs(cos), shape) + Math.pow(Math.abs(sin), shape),
            1 / shape,
          );
        const anchorRadial = band[0] + random() * (band[1] - band[0]);
        anchorX = cx + cos * reach * anchorRadial * rx;
        anchorY = cy + sin * reach * anchorRadial * ry;
      } else {
        anchorX = cx + (random() - 0.5) * 2 * rx * spread;
        anchorY = cy + (random() - 0.5) * 2 * ry * spread;
      }
      const angleOffset = random() * Math.PI * 2;

      for (let spacing = gap; spacing >= 0; spacing -= gap / 2) {
        let found = false;
        for (let radius = 0; radius <= rx && !found; radius += Math.max(4, size * 0.12)) {
          const samples = Math.max(14, Math.ceil((Math.PI * 2 * radius) / (size * 1.15)));
          for (let index = 0; index < samples; index += 1) {
            const angle = angleOffset + (index / samples) * Math.PI * 2 + (random() - 0.5) * 0.22;
            const x = anchorX + Math.cos(angle) * radius + (random() - 0.5) * size * 0.28;
            const y =
              anchorY +
              Math.sin(angle) * radius * (ry / rx) +
              (random() - 0.5) * size * 0.22;
            if (floor > 0 && radial(x, y) < floor) continue;
            if (!inside(x, y, w, h)) continue;
            if (hits(x, y, w, h, spacing)) continue;
            const offset = Math.hypot(x - anchorX, y - anchorY);
            if (spacing > bestSpacing || (spacing === bestSpacing && offset < nearest)) {
              bestSpacing = spacing;
              nearest = offset;
              position = { x, y };
            }
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    if (!position) {
      for (let y = cy - ry; y <= cy + ry && !position; y += 4) {
        for (let x = cx - rx; x <= cx + rx && !position; x += 4) {
          if (floor > 0 && radial(x, y) < floor) continue;
          if (!inside(x, y, w, h)) continue;
          if (hits(x, y, w, h, 0)) continue;
          position = { x, y };
        }
      }
    }

    if (!position) {
      for (let y = cy - ry; y <= cy + ry && !position; y += 4) {
        for (let x = cx - rx; x <= cx + rx && !position; x += 4) {
          if (!inside(x, y, w, h)) continue;
          if (hits(x, y, w, h, 0)) continue;
          position = { x, y };
        }
      }
    }

    if (!position) {
      position = { x: cx, y: cy };
    }

    boxes.push({ x: position.x, y: position.y, w, h });

    const baseAmp = item.tier === 1 ? 10 : item.tier === 2 ? 13 : item.tier === 3 ? 16 : 19;
    const loFactor = item.tier === 1 ? 0.8 : item.tier === 2 ? 0.68 : item.tier === 3 ? 0.58 : 0.5;
    const dur = 12 + random() * 10;

    placedWords.push({
      ...item,
      x: position.x,
      y: position.y,
      size,
      dur,
      delay: random() * dur,
      amp: baseAmp * (0.85 + random() * 0.35) * ampScale,
      lo: Math.max(0.4, item.fade * loFactor),
    });
  }

  return { width, height, words: placedWords };
}
