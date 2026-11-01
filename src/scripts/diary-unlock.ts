/**
 * 封存日记的解锁流程（只在 locked 的日记内页加载）。
 *
 * 单输入框同时接受两种钥匙：
 *   - 主密码：解开公开 keyring，拿这一篇的 DEK（所有封存日记通用）
 *   - 分享码：解开这一篇的 share 块，只拿这一篇的 DEK
 * 先按输入形态猜一次（20 位 Crockford Base32 先当分享码；旧记录可能残留 32 位，一并识别），失败再试另一种。
 *
 * 三次认证失败 → /void/；完整性错误、网络错误不计次数。
 * 解密后的图片是 Blob URL，离页即回收。
 */
import type { TypingLexicon } from '../lib/typing-data';

const MAX_ATTEMPTS = 3;
const ATTEMPT_PREFIX = 'moxo:diary-attempts:v1:';
const TYPING_PREFIX = 'moxo:diary-input:v1:';
const SHARE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 生成器固定输出 20 位（100 bit）；兼容早期 32 位形态。 */
const SHARE_CODE_LENGTH = 20;
const LEGACY_SHARE_CODE_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Kdf {
  name: string;
  hash: string;
  iterations: number;
}

interface KeyringFile {
  v: number;
  kdf?: Kdf;
  salt: string;
  iv: string;
  ct: string;
}

interface SealedFile {
  v: number;
  alg: string;
  kdf: Kdf;
  entryId: string;
  share: { salt: string; iv: string; ct: string };
  payload: { iv: string; ct: string };
  images?: { n: number; file: string }[];
  sealedHash: string;
}

interface Payload {
  v: number;
  id: string;
  title: string | null;
  html: string;
  lexicon: TypingLexicon | null;
  gallery: { n: number | null; mime?: string; src?: string; back?: string }[];
  images: { n: number; file: string; mime: string }[];
}

class AuthError extends Error {}
class CorruptError extends Error {}
class FetchError extends Error {}

const b64ToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function normalizeShareCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deriveKek(passphrase: string, saltB64: string, kdf: Kdf): Promise<CryptoKey> {
  // 迭代次数来自公开文件：给一个合理区间，参数被改坏时直接报损坏，不去跑离谱的派生。
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 100_000 || kdf.iterations > 10_000_000) {
    throw new CorruptError('密钥派生参数异常');
  }
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(saltB64),
      iterations: kdf.iterations,
      hash: kdf.hash,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

async function decryptBlock(key: CryptoKey, block: { iv: string; ct: string }): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(block.iv) },
    key,
    b64ToBytes(block.ct),
  );
}

async function importDek(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function verifySealed(sealed: SealedFile): Promise<void> {
  const material = [
    sealed.payload.iv,
    sealed.payload.ct,
    sealed.share.salt,
    sealed.share.iv,
    sealed.share.ct,
  ].join('|');
  if (`sha256:${await sha256Hex(material)}` !== sealed.sealedHash) {
    throw new CorruptError('密文完整性校验没通过');
  }
}

let keyringPromise: Promise<KeyringFile> | null = null;
let keyringUrlCache = '';

async function loadKeyring(url: string): Promise<KeyringFile> {
  if (keyringPromise && keyringUrlCache === url) return keyringPromise;
  keyringUrlCache = url;
  keyringPromise = fetch(url, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new FetchError('公开钥匙环没有取到');
      return (await response.json()) as KeyringFile;
    })
    .catch((error) => {
      keyringPromise = null;
      throw error;
    });
  return keyringPromise;
}

async function unwrapWithMaster(
  passphrase: string,
  sealed: SealedFile,
  keyringUrl: string,
): Promise<CryptoKey> {
  const keyring = await loadKeyring(keyringUrl);
  const kdf = keyring.kdf ?? sealed.kdf;
  const kek = await deriveKek(passphrase, keyring.salt, kdf);
  let plain: ArrayBuffer;
  try {
    plain = await decryptBlock(kek, keyring);
  } catch {
    throw new AuthError('主密码不对');
  }

  let data: { v?: number; entries?: Record<string, string> };
  try {
    data = JSON.parse(decoder.decode(plain));
  } catch {
    throw new CorruptError('钥匙环内容损坏');
  }
  const dek = data?.entries?.[sealed.entryId];
  if (typeof dek !== 'string') throw new CorruptError('钥匙环里没有这一篇');
  return importDek(b64ToBytes(dek));
}

async function unwrapWithShare(passphrase: string, sealed: SealedFile): Promise<CryptoKey> {
  const code = normalizeShareCode(passphrase);
  if (!code) throw new AuthError('分享码为空');
  const kek = await deriveKek(code, sealed.share.salt, sealed.kdf);
  let raw: ArrayBuffer;
  try {
    raw = await decryptBlock(kek, sealed.share);
  } catch {
    throw new AuthError('分享码不对');
  }
  return importDek(new Uint8Array(raw));
}

async function decryptPayload(dek: CryptoKey, sealed: SealedFile): Promise<Payload> {
  let plain: ArrayBuffer;
  try {
    plain = await decryptBlock(dek, sealed.payload);
  } catch {
    throw new CorruptError('正文解密失败');
  }

  let payload: Payload;
  try {
    payload = JSON.parse(decoder.decode(plain));
  } catch {
    throw new CorruptError('正文内容损坏');
  }
  if (payload?.id !== sealed.entryId || typeof payload.html !== 'string') {
    throw new CorruptError('正文结构不对');
  }
  return payload;
}

async function decryptImages(
  dek: CryptoKey,
  payload: Payload,
  baseUrl: string,
): Promise<{ urls: Map<number, string>; blobs: string[] }> {
  const urls = new Map<number, string>();
  const blobs: string[] = [];
  const base = new URL(baseUrl, location.href);

  await Promise.all(
    payload.images.map(async (image) => {
      const response = await fetch(new URL(image.file, base), { cache: 'no-store' });
      if (!response.ok) throw new FetchError('加密图片没有取到');
      const packed = new Uint8Array(await response.arrayBuffer());
      if (packed.length <= 12) throw new CorruptError('加密图片损坏');

      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: packed.slice(0, 12) },
          dek,
          packed.slice(12),
        );
      } catch {
        throw new CorruptError('图片解密失败');
      }

      const url = URL.createObjectURL(new Blob([plain], { type: image.mime || 'application/octet-stream' }));
      urls.set(image.n, url);
      blobs.push(url);
    }),
  );

  return { urls, blobs };
}

function readAttempts(entryId: string): number {
  try {
    const value = Number(sessionStorage.getItem(`${ATTEMPT_PREFIX}${entryId}`) ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.min(MAX_ATTEMPTS, value)) : 0;
  } catch {
    return 0;
  }
}

function writeAttempts(entryId: string, value: number): void {
  try {
    sessionStorage.setItem(`${ATTEMPT_PREFIX}${entryId}`, String(value));
  } catch {
    /* 存不了就让这次会话自己记着 */
  }
}

function clearSeen(entryId: string): void {
  try {
    // 封存日记第一次解锁要看到显影；之前没打字，所以这里是空的，清一下更稳
    sessionStorage.removeItem(`${TYPING_PREFIX}${entryId}`);
  } catch {
    /* 私密窗口禁用存储时每次都会重播 */
  }
}

function makeGallery(payload: Payload, urls: Map<number, string>, dateLabel: string): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const item of payload.gallery) {
    const src = item.n === null ? item.src : urls.get(item.n);
    if (!src) continue;

    const figure = document.createElement('figure');
    figure.className = item.back ? 'diary-figure is-flippable' : 'diary-figure';
    figure.dataset.lightbox = '';

    const paper = document.createElement('div');
    paper.className = 'diary-figure-paper';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diary-figure-btn';
    button.setAttribute('aria-label', '查看日记图片大图');

    const img = document.createElement('img');
    img.className = 'pimg is-static';
    img.src = src;
    img.dataset.full = src;
    img.alt = '日记配图';
    img.decoding = 'async';

    button.append(img);
    paper.append(button);

    if (item.back) {
      const back = document.createElement('div');
      back.className = 'diary-figure-back';
      const note = document.createElement('p');
      note.className = 'diary-figure-back-note';
      note.textContent = item.back;
      const stamp = document.createElement('span');
      stamp.className = 'diary-figure-back-stamp';
      stamp.textContent = dateLabel ? `${dateLabel} · 小航 m∞` : '小航 m∞';
      back.append(note, stamp);
      paper.append(back);
    }

    figure.append(paper);
    fragment.append(figure);
  }

  return fragment;
}

function reveal(payload: Payload, urls: Map<number, string>, lock: HTMLElement): void {
  const entryId = lock.dataset.entryId ?? '';
  const unsealed = document.querySelector<HTMLElement>('[data-diary-unsealed]');
  const typingHost = unsealed?.querySelector<HTMLElement>('[data-diary-typing]');
  const source = typingHost?.querySelector<HTMLElement>('[data-diary-typing-source]');
  if (!unsealed || !typingHost || !source) return;

  writeAttempts(entryId, 0);

  const eyebrow = document.querySelector<HTMLElement>('[data-lock-eyebrow]');
  const weekday = lock.dataset.weekday ?? '';
  if (eyebrow) eyebrow.textContent = `${weekday} / ${payload.title ?? 'DAILY NOTE'}`;

  const stamp = lock.dataset.dateStamp ?? '';
  if (payload.title && stamp) document.title = `${payload.title} · 日记 · ${stamp}`;

  lock.classList.add('is-broken');
  window.setTimeout(() => {
    lock.hidden = true;
    unsealed.hidden = false;

    const galleryHost = unsealed.querySelector<HTMLElement>('[data-diary-gallery]');
    if (galleryHost && payload.gallery.length > 0) {
      galleryHost.hidden = false;
      galleryHost.classList.toggle('is-single', payload.gallery.length === 1);
      galleryHost.append(makeGallery(payload, urls, lock.dataset.dateLabel ?? ''));
    }

    source.innerHTML = payload.html;
    for (const img of Array.from(source.querySelectorAll<HTMLImageElement>('img[data-sealed-image]'))) {
      const n = Number(img.dataset.sealedImage);
      const src = urls.get(n);
      if (!src) {
        img.remove();
        continue;
      }
      img.classList.add('pimg', 'is-static');
      img.src = src;
      img.dataset.full = src;
      img.removeAttribute('data-sealed-image');
    }

    typingHost.querySelector('[data-diary-typing-lexicon]')?.remove();
    if (payload.lexicon) {
      const lexicon = document.createElement('script');
      lexicon.type = 'application/json';
      lexicon.setAttribute('data-diary-typing-lexicon', '');
      lexicon.textContent = JSON.stringify(payload.lexicon).replace(/</g, '\\u003c');
      const skip = typingHost.querySelector('[data-diary-typing-skip]');
      typingHost.insertBefore(lexicon, skip);
    }

    clearSeen(entryId);
    typingHost.dataset.typingState = payload.lexicon ? 'pending' : 'done';
    delete typingHost.dataset.typingReady;
    document.dispatchEvent(new CustomEvent('moxo:diary-unlocked'));

    const announcer = unsealed.querySelector<HTMLElement>('[data-unlock-announcer]');
    if (announcer) announcer.textContent = '已解封，正文开始显影。按 ESC 可以跳过。';
    unsealed.focus({ preventScroll: true });
  }, 280);
}

function initLock(lock: HTMLElement): void {
  if (lock.dataset.lockReady === 'true') return;
  lock.dataset.lockReady = 'true';

  const form = lock.querySelector<HTMLFormElement>('[data-lock-form]');
  const input = lock.querySelector<HTMLInputElement>('[data-lock-input]');
  const submit = lock.querySelector<HTMLButtonElement>('[data-lock-submit]');
  const submitLabel = lock.querySelector<HTMLElement>('[data-lock-submit-label]');
  const revealButton = lock.querySelector<HTMLButtonElement>('[data-lock-reveal]');
  const errorBox = lock.querySelector<HTMLElement>('[data-lock-error]');
  const status = lock.querySelector<HTMLElement>('[data-lock-status]');
  const dots = Array.from(lock.querySelectorAll<HTMLElement>('[data-lock-dots] i'));
  const announcer = lock.querySelector<HTMLElement>('[data-lock-announcer]');
  if (!form || !input || !submit) return;

  const entryId = lock.dataset.entryId ?? '';
  const keyringUrl = lock.dataset.keyring ?? '';
  const sealedUrl = lock.dataset.sealed ?? '';
  const sealedBase = lock.dataset.sealedBase ?? '';
  const voidUrl = lock.dataset.void ?? '';
  const objectUrls: string[] = [];
  let busy = false;

  if (!globalThis.crypto?.subtle) {
    input.disabled = true;
    submit.disabled = true;
    if (errorBox) errorBox.textContent = '这个浏览器/连接不支持 WebCrypto，请用 HTTPS 或 localhost 打开。';
    return;
  }

  const refreshAttempts = (): number => {
    const used = readAttempts(entryId);
    const left = Math.max(0, MAX_ATTEMPTS - used);
    dots.forEach((dot, index) => dot.classList.toggle('is-spent', index < used));
    if (status) status.textContent = left === 0 ? '次数已用完' : `还有 ${left} 次`;
    return used;
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    lock.classList.toggle('is-busy', value);
    submit.setAttribute('aria-busy', String(value));
    input.disabled = value;
    submit.disabled = value;
    if (revealButton) revealButton.disabled = value;
    if (submitLabel) submitLabel.textContent = value ? '解封中…' : '解封';
  };

  const setError = (message: string, invalid: boolean): void => {
    if (errorBox) errorBox.textContent = message;
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  const goVoid = (): void => {
    lock.classList.add('is-voiding');
    document.body.classList.add('is-voiding');
    if (status) status.textContent = '次数已用完';
    window.setTimeout(() => {
      const target = new URL(voidUrl, location.href);
      target.searchParams.set('from', entryId);
      location.replace(target.href);
    }, 680);
  };

  const countFailure = (): void => {
    const used = Math.min(MAX_ATTEMPTS, readAttempts(entryId) + 1);
    writeAttempts(entryId, used);
    refreshAttempts();
    lock.classList.remove('is-shaking');
    void lock.offsetWidth;
    lock.classList.add('is-shaking');
    input.setAttribute('aria-invalid', 'true');
    setBusy(false);

    if (used >= MAX_ATTEMPTS) {
      setError('三次都错了。', true);
      goVoid();
      return;
    }

    setError(`不对。还剩 ${MAX_ATTEMPTS - used} 次。`, true);
    input.select();
    input.focus();
  };

  const startSealed = async (passphrase: string): Promise<void> => {
    const started = performance.now();
    setBusy(true);
    setError('', false);
    if (status) status.textContent = '正在派生钥匙…';
    if (announcer) announcer.textContent = '正在解密，请稍候。';

    try {
      const response = await fetch(sealedUrl, { cache: 'no-store' });
      if (!response.ok) throw new FetchError('密文没有取到');
      const sealed = (await response.json()) as SealedFile;
      await verifySealed(sealed);

      const normalized = normalizeShareCode(passphrase);
      const looksShare =
        (normalized.length === SHARE_CODE_LENGTH || normalized.length === LEGACY_SHARE_CODE_LENGTH) &&
        Array.from(normalized).every((char) => SHARE_ALPHABET.includes(char));
      const order: Array<'master' | 'share'> = looksShare ? ['share', 'master'] : ['master', 'share'];

      let dek: CryptoKey | null = null;
      let structural: Error | null = null;

      for (const mode of order) {
        try {
          dek = mode === 'master'
            ? await unwrapWithMaster(passphrase, sealed, keyringUrl)
            : await unwrapWithShare(passphrase, sealed);
          break;
        } catch (error) {
          if (error instanceof CorruptError) {
            structural = error;
            break;
          }
          if (!(error instanceof AuthError)) throw error;
        }
      }

      if (!dek) {
        if (structural) throw structural;
        throw new AuthError('钥匙不对');
      }

      const payload = await decryptPayload(dek, sealed);
      const { urls, blobs } = await decryptImages(dek, payload, sealedBase);
      objectUrls.push(...blobs);

      const elapsed = performance.now() - started;
      if (elapsed < 680) await new Promise((resolve) => window.setTimeout(resolve, 680 - elapsed));

      setBusy(false);
      reveal(payload, urls, lock);
    } catch (error) {
      setBusy(false);

      if (error instanceof CorruptError) {
        setError('密文完整性校验没通过，文件可能损坏。此次不计入次数。', false);
        if (status) status.textContent = `还有 ${Math.max(0, MAX_ATTEMPTS - readAttempts(entryId))} 次`;
        return;
      }
      if (error instanceof FetchError) {
        setError('密文没有取到，检查网络后再试。此次不计入次数。', false);
        if (status) status.textContent = `还有 ${Math.max(0, MAX_ATTEMPTS - readAttempts(entryId))} 次`;
        return;
      }
      if (!(error instanceof AuthError)) {
        // 密码对不对是 AuthError；走到这里说明是脚本/页面结构出错，不该消耗次数
        console.error('[diary-unlock] 解锁时发生意外错误：', error);
        setError('解锁时出了点问题，刷新后再试。此次不计入次数。', false);
        if (status) status.textContent = `还有 ${Math.max(0, MAX_ATTEMPTS - readAttempts(entryId))} 次`;
        return;
      }

      countFailure();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    if (readAttempts(entryId) >= MAX_ATTEMPTS) {
      setError('三次机会已用完。', true);
      goVoid();
      return;
    }

    // 不再 trim：主密码按输入原样派生（与 Node 端一致），只把「全是空白」当作空输入。
    const passphrase = input.value;
    if (!passphrase.trim()) {
      setError('先输入分享码或主密码。', true);
      input.focus();
      return;
    }
    void startSealed(passphrase);
  });

  revealButton?.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    revealButton.textContent = show ? '隐藏' : '显示';
    revealButton.setAttribute('aria-label', show ? '隐藏输入' : '显示输入');
    input.focus();
  });

  input.addEventListener('input', () => {
    if (readAttempts(entryId) < MAX_ATTEMPTS) setError('', false);
  });

  const used = refreshAttempts();
  if (used >= MAX_ATTEMPTS) {
    setError('三次机会已用完。', true);
    input.disabled = true;
    submit.disabled = true;
  }

  const cleanup = (): void => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
  };
  window.addEventListener('pagehide', cleanup, { once: true });
  document.addEventListener('astro:before-swap', cleanup, { once: true });
}

function init(): void {
  keyringPromise = null;
  keyringUrlCache = '';
  document.querySelectorAll<HTMLElement>('[data-diary-lock]').forEach(initLock);
}

document.addEventListener('astro:page-load', init);
