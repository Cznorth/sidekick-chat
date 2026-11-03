/**
 * 和 chat World 的 HTTP 接口打交道:鉴权、状态、历史、发送、SSE 推流。
 *
 * 只认两条路:设备令牌(Bearer,和手机 App 同一个 `SIDEKICK_DEVICE_TOKEN`),或网页登录拿到的
 * `cortico_session` Cookie(和网页版同一个 `CORTICO_WEB_PASSWORD`)。接口本身见
 * packages/world-chat/src/world.ts 的 `startHub`。
 */
import { authOrigin } from './config.mjs';

/** 鉴权没过:登录态失效或令牌不对,调用方据此提示重新登录。 */
export class AuthError extends Error {}

/** 连不上(没拿到响应):只有这种错才换备用线路,4xx / 5xx 不换。 */
export class NetworkError extends Error {}

const REQUEST_TIMEOUT_MS = 20_000;

export class SidekickApi {
  /** `alt` 是备用线路(如杭州 `http://47.96.64.66:18792`),只有主线路连不上才用。 */
  constructor({ url, alt, token, cookie }) {
    this.primary = stripSlashes(String(url || ''));
    this.alt = stripSlashes(String(alt || ''));
    /** 当前用着哪条:切到备用线路后就不再每次先撞一次主线路。 */
    this.current = this.primary;
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

  /** 先试当前线路,连不上再试备用线路(只有拿不到响应才算连不上)。 */
  async attempt(run) {
    const bases = [this.current === this.alt ? this.primary : this.current];
    if (this.alt && this.alt !== bases[0]) bases.push(this.alt);
    let last;
    for (const base of bases) {
      try {
        const out = await run(base);
        this.current = base;
        return out;
      } catch (err) {
        if (!(err instanceof NetworkError)) {
          // 备用线路上没有网页登录接口:提示改用令牌,别让人以为密码错了。
          if (err instanceof AuthError && base === this.alt && this.cookie) {
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
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new AuthError(data.error || '登录态已失效');
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

  send({ conv, text, device }) {
    return this.request('POST', 'v1/team/send', { conv, text, device });
  }

  read(conv, seq) {
    return this.request('POST', 'v1/team/read', { conv, seq });
  }

  imageUrl(name) {
    return `${this.base}/v1/team/image?name=${encodeURIComponent(name)}`;
  }

  /**
   * 订阅推流,断了按退避重连,重连时带上最后的 seq 把漏掉的补齐。
   * `onEvent(event, payload)` 收到 hello / state / message / draft / thinking / busy / read。
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
      const r = await fetch(url, {
        headers: { ...this.headers, accept: 'text/event-stream' },
        signal,
      }).catch((err) => {
        throw new NetworkError(networkHint(url, err));
      });
      // 4xx / 5xx 不是网络问题,不换线路重试。
      if (r.status === 401) throw new AuthError('登录态已失效');
      if (!r.ok) throw new Error(`推流 HTTP ${r.status}`);
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
