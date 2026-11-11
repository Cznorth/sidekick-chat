/**
 * 和 chat World 的 HTTP 接口打交道:鉴权、状态、历史、发送、SSE 推流。
 *
 * 只认两条路:设备令牌(Bearer,和手机 App 同一个 `SIDEKICK_DEVICE_TOKEN`),或网页登录拿到的
 * `cortico_session` Cookie(和网页版同一个 `CORTICO_WEB_PASSWORD`)。接口本身见
 * packages/world-chat/src/world.ts 的 `startHub`。
 */
import { randomUUID } from 'node:crypto';
import { authOrigin } from './config.mjs';

/** 鉴权没过:登录态失效或令牌不对,调用方据此提示重新登录。 */
export class AuthError extends Error {}

/** 连不上(没拿到响应):只有这种错才换备用线路,4xx 不换。 */
export class NetworkError extends Error {}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 网关错误通常是隧道断了、上游没起来,换一条线路可能就好了。 */
function routeFailed(err) {
  return err instanceof NetworkError || (err instanceof HttpError && [502, 503, 504].includes(err.status));
}

const REQUEST_TIMEOUT_MS = 20_000;
/** 换到备用线路后,过这么久再试回主线路。 */
const PRIMARY_RETRY_MS = 5 * 60_000;

export class SidekickApi {
  /**
   * `alts` 是备用线路列表(美国直连、阿里→香港→美国),按顺序在连不上时换;
   * `alt` 是旧版的单条写法,仍认。
   */
  constructor({ url, alt, alts, token, cookie, now = Date.now, primaryRetryMs = PRIMARY_RETRY_MS }) {
    this.primary = stripSlashes(String(url || ''));
    const list = Array.isArray(alts) ? alts : alts !== undefined ? [alts] : alt !== undefined ? [alt] : [];
    this.alts = [...new Set(list.map((b) => stripSlashes(String(b || ''))).filter((b) => b && b !== this.primary))];
    /** 当前用着哪条:切到备用线路后就不再每次先撞一次主线路。 */
    this.current = this.primary;
    this.switchedAt = 0;
    this.now = now;
    this.primaryRetryMs = primaryRetryMs;
    this.token = token || '';
    this.cookie = cookie || '';
  }

  get base() {
    return this.current;
  }

  get headers() {
    const h = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.cookie) h.cookie = `cortico_session=${this.cookie}`;
    return h;
  }

  /**
   * 当前线路优先;换到备用线路超过 5 分钟后,下一次请求先试回主线路。
   * 返回的列表里不再包含已经试过的那条当前线路。
   */
  routeOrder() {
    const all = [this.primary, ...this.alts].filter(Boolean);
    if (this.current === this.primary) return all;
    const backups = all.filter((b) => b !== this.primary);
    if (this.now() - this.switchedAt >= this.primaryRetryMs) return [this.primary, ...backups];
    // 还没到回头试主线路的时候:当前这条优先,其余备用在后面,主线路垫底。
    return [this.current, ...backups.filter((b) => b !== this.current), this.primary];
  }

  /** 先试当前线路,连不上再按顺序试备用线路。4xx 是请求本身的问题,不换。 */
  async attempt(run) {
    let last;
    for (const base of this.routeOrder()) {
      try {
        const out = await run(base);
        if (this.current !== base) this.switchedAt = base === this.primary ? 0 : this.now();
        this.current = base;
        return out;
      } catch (err) {
        if (!routeFailed(err)) {
          // 备用线路上没有网页登录接口:提示改用令牌,别让人以为密码错了。
          if (err instanceof AuthError && base !== this.primary && this.cookie) {
            throw new AuthError('备用线路不认网页登录,改成 sidekick login --token <设备令牌>');
          }
          throw err;
        }
        last = err;
      }
    }
    throw last;
  }

  async request(method, path, body, { signal } = {}) {
    return this.attempt(async (base) => {
      const url = `${base}/${path.replace(/^\/+/, '')}`;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw new NetworkError(networkHint(url, err));
      }
      let data;
      try { data = await res.json(); }
      catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!res.ok) data = {};
        else throw new NetworkError(networkHint(url, err));
      }
      if (res.status === 401) throw new AuthError(data.error || '登录态已失效');
      if (!res.ok) throw new HttpError(res.status, data.error || `HTTP ${res.status}`);
      return data;
    });
  }

  /** 拿一次服务器全貌:主 Bot、名册、会话列表和全局最新的 seq。 */
  state() {
    return this.request('GET', 'v1/team/state');
  }

  history(conv, limit = 60) {
    return this.request('GET', `v1/team/history?conv=${encodeURIComponent(conv)}&limit=${limit}`);
  }

  async send({ conv, text, device, images }, { signal, onRetry } = {}) {
    const body = { conv, text, device, images, client_id: randomUUID() };
    let delay = 1000;
    for (;;) {
      signal?.throwIfAborted();
      try { return await this.request('POST', 'v1/team/send', body, { signal }); }
      catch (err) {
        if (!(err instanceof NetworkError) && !(err instanceof HttpError && [408, 502, 503, 504].includes(err.status))) throw err;
        onRetry?.(err);
        signal?.throwIfAborted();
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  read(conv, seq) {
    return this.request('POST', 'v1/team/read', { conv, seq });
  }

  imageUrl(name) {
    return this.attachmentUrl('image', name);
  }

  attachmentUrl(kind, name) {
    if (!['image', 'file'].includes(kind)) throw new Error('无效的附件类型');
    return `${this.base}/v1/team/${kind}?name=${encodeURIComponent(name)}`;
  }

  async attachment(kind, name, { signal } = {}) {
    if (!['image', 'file'].includes(kind) || typeof name !== 'string' || !name) throw new Error('无效的附件');
    return this.attempt(async (base) => {
      const url = `${base}/v1/team/${kind}?name=${encodeURIComponent(name)}`;
      let res;
      try {
        res = await fetch(url, { headers: this.headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw new NetworkError(networkHint(url, err));
      }
      if (res.status === 401) throw new AuthError('登录态已失效');
      if (!res.ok) throw new HttpError(res.status, `附件下载失败:HTTP ${res.status}`);
      const limit = 60 * 1024 * 1024;
      if (Number(res.headers.get('content-length')) > limit) throw new Error('附件超过 60 MB');
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limit) throw new Error('附件超过 60 MB');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    });
  }

  /**
   * 订阅推流,断了按退避重连,重连时带上最后的 seq 把漏掉的补齐。
   * `onEvent(event, payload)` 收到 hello / state / message / draft / thinking / busy / activity / read。
   * 返回的 promise 只在 abort 时结束。
   */
  async stream({ after = 0, device, signal, onEvent, onStatus }) {
    let seq = after;
    let delay = 1000;
    while (!signal.aborted) {
      try {
        await this.openStream({ after: seq, device, signal, onEvent: (event, payload) => {
          if (event === 'message' && typeof payload?.seq === 'number') seq = Math.max(seq, payload.seq);
          if (event === 'state' && typeof payload?.latest === 'number') seq = Math.max(seq, payload.latest);
          onEvent(event, payload);
        }, onStatus });
        delay = 1000;
        onStatus?.('closed');
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof AuthError) throw err;
        onStatus?.('error', err);
      }
      // 断线重连:1s、2s、4s…最多 30s。
      await sleep(delay, signal);
      delay = Math.min(30_000, delay * 2);
    }
  }

  async openStream({ after, device, signal, onEvent, onStatus }) {
    const res = await this.attempt(async (base) => {
      const url = `${base}/v1/team/stream?after=${after}&device=${encodeURIComponent(device || '终端')}`;
      const connect = new AbortController();
      const timer = setTimeout(() => connect.abort(), REQUEST_TIMEOUT_MS);
      let r;
      try {
        r = await fetch(url, {
          headers: { ...this.headers, accept: 'text/event-stream' },
          signal: AbortSignal.any([signal, connect.signal]),
        });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        throw new NetworkError(networkHint(url, err));
      } finally {
        clearTimeout(timer);
      }
      if (r.status === 401) throw new AuthError('登录态已失效');
      if (!r.ok) throw new HttpError(r.status, `推流 HTTP ${r.status}`);
      return r;
    });
    if (!res.body) throw new Error('推流没有响应体');
    onStatus?.('open');
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const frame = parseFrame(block);
          if (frame) onEvent(frame.event, frame.data);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

/** SSE 一块:`event: x` + 若干 `data:` 行;只有注释(心跳)或 `retry:` 时返回 null。 */
export function parseFrame(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

/** 用网页登录密码换登录态 Cookie;WebUI 不在这个地址上时抛错说明改用令牌。 */
export async function loginWithPassword(url, password) {
  const endpoint = `${authOrigin(url)}/api/auth/login`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`连不上 ${endpoint}:${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) throw new AuthError('密码不对');
  if (res.status === 404) throw new Error(`${authOrigin(url)} 上没有网页登录接口,请改用 --token(设备令牌)`);
  if (!res.ok) throw new Error(`登录失败:HTTP ${res.status}`);
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const m = /(?:^|;\s*)cortico_session=([^;]+)/.exec(line || '');
    if (m) return decodeURIComponent(m[1]);
  }
  throw new Error('服务器没发登录 Cookie,请改用 --token(设备令牌)');
}

/** fetch 在网络层失败时只给一句 `fetch failed`,这里把地址和常见原因一起说出来。 */
export function networkHint(url, err) {
  if (err instanceof Error && err.name === 'TimeoutError') return `连不上 ${url}(超时)`;
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  return `连不上 ${url}${cause ? `(${cause})` : ''}`;
}

function stripSlashes(url) {
  return url.replace(/\/+$/, '');
}

/** 等 ms 毫秒;signal 中止时提前返回。 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}
