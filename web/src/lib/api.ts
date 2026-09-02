interface BrowserLocation {
  href: string;
  search: string;
}

function browserLocation(): BrowserLocation {
  const value = (globalThis as { location?: BrowserLocation }).location;
  if (!value) throw new Error("browser location is unavailable");
  return value;
}

function currentToken(): string {
  return new URLSearchParams(browserLocation().search).get("token") ?? "";
}

/**
 * Resolve the console API beside the page that served it. The local console is
 * served from `/`, while an authenticated management plane may mount the same
 * shell below a path such as `/admin-api/aria-console/`. Keeping the API
 * relative to the document directory supports both without weakening the
 * loopback-only server boundary.
 */
export function resolveApiUrl(path: string, pageHref: string = browserLocation().href): string {
  const relativePath = path.replace(/^\/?api\//, "");
  const apiRoot = new URL("api/", new URL(".", pageHref));
  return new URL(relativePath, apiRoot).toString();
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...opts,
    headers: {
      "x-ui-token": currentToken(),
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`);
  return data as T;
}

export const apiGet = <T = unknown>(path: string) => api<T>(path);
export const apiPost = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
