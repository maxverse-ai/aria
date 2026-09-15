import { resolveAppPaths } from '../config/app-paths';
import { isAlive } from '../runtime/registry';
import { readUiSidecar } from '../ui/sidecar';

/** Use the existing host's authenticated lifecycle endpoint; never spawn a second host. */
export async function startProfileOnHost(profile: string, rootDir?: string): Promise<void> {
  const sidecar = await readUiSidecar(resolveAppPaths({ rootDir }).hostUiFile);
  if (!sidecar || !Number.isInteger(sidecar.pid) || !isAlive(sidecar.pid)) {
    throw new Error('未检测到运行中的 Supervisor。请先执行 aria start --web-ui，再重试上线。');
  }
  const advertised = new URL(sidecar.url);
  if (advertised.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(advertised.hostname) ||
    advertised.username || advertised.password) {
    throw new Error('Supervisor 地址不是有效的本机 HTTP 地址');
  }
  const url = new URL('/api/profiles/start', advertised.origin);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ui-token': sidecar.token },
      body: JSON.stringify({ profile }),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error('无法确认 Supervisor 启动结果；请查看 aria runtime status 或控制台后重试。');
  }
  const result = await response.json() as { ok?: boolean; profile?: string; error?: string };
  if (!response.ok || result.ok !== true || result.profile !== profile) {
    throw new Error(result.error ?? `Supervisor 启动失败（HTTP ${response.status}）`);
  }
}
