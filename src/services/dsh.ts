/**
 * DeepSeek Harness 手机版 — dsh 本地服务连接层。
 *
 * 手机 App 通过 Termux 内的 dsh 引擎运行完整 harness（功能与桌面版一致），
 * App 通过 127.0.0.1 回环地址访问其 Web 服务。这里实现了连接检测所需的
 * RPC 信封（host.describe），与 dsh 的 /api 协议一致。
 */

/** 生成一个符合 dsh RPC 契约的 rpcId（UUID v4，Hermes 上无 crypto.randomUUID 时回退）。 */
export function makeRpcId(): string {
  // Hermes 不保证提供 crypto.randomUUID，这里手动构造一个 v4 UUID。
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export interface DescribeResult {
  ok: boolean;
  version?: string;
  cwd?: string;
  error?: string;
}

/** 探测 dsh 本地服务：调用 host.describe 并返回主机快照。 */
export async function describeHost(port: number): Promise<DescribeResult> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${base}/api/host.describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: makeRpcId(),
        method: 'host.describe',
        payload: {},
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `服务返回 HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data?.result?.ok === true) {
      return {
        ok: true,
        version: data.result.value?.version,
        cwd: data.result.value?.cwd,
      };
    }
    const msg = data?.result?.error?.message ?? '服务未正确响应';
    return { ok: false, error: String(msg) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // fetch 拒绝（未监听/连接被拒）时给出友好提示。
    if (/network|fetch|abort/i.test(message)) {
      return { ok: false, error: '未检测到 dsh 服务，请先在 Termux 中启动' };
    }
    return { ok: false, error: message };
  }
}

/** 一次 GET 探测（等价于 describe，用于快速判断服务是否存活）。 */
export async function pingHost(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: makeRpcId(),
        method: 'host.describe',
        payload: {},
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}
