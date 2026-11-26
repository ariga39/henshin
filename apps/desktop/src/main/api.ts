export type Connection = { url: string; token: string };
export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function serverApiUrl(serverUrl: string, endpoint: string): URL {
  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new ApiError('The configured server URL is invalid. Check it in Settings.');
  }
  if (server.protocol !== 'http:' && server.protocol !== 'https:') {
    throw new ApiError('The server URL must use HTTP or HTTPS.');
  }
  if (!endpoint.startsWith('/api/') || endpoint.startsWith('//')) {
    throw new ApiError('API requests must use a path on the configured server.');
  }

  const url = new URL(endpoint, `${server.origin}/`);
  if (url.origin !== server.origin) {
    throw new ApiError('API requests must stay on the configured server origin.');
  }
  return url;
}

export async function request<T>(connection: Connection, endpoint: string, init: RequestInit = {}): Promise<T> {
  if (!connection.url || !connection.token) throw new ApiError('Set the server URL and bearer token in Settings first.');
  const url = serverApiUrl(connection.url, endpoint);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers, Authorization: `Bearer ${connection.token}` },
    });
  } catch {
    throw new ApiError('Could not reach the Henshin server. Check that it is running and the URL is correct.');
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json() as { error?: string }).error ?? ''; } catch { /* use status message */ }
    const message = detail || (
      response.status === 401 ? 'The server rejected the bearer token. Check it in Settings.'
        : response.status === 404 ? 'The requested server item was not found.'
        : response.status === 409 ? 'The server reported a conflict.'
        : `The server returned HTTP ${response.status}.`
    );
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
