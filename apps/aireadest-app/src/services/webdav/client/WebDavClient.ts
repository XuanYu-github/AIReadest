import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { WebDavClientOptions, WebDavDepth, WebDavPropfindResource, WebDavQuota, WebDavResponse } from './types';
import { basicAuthHeaderValue, decodeMaybeBase64Password, joinDavPaths, normalizeRootPath, normalizeServerUrl, normalizeDavPath } from './utils';
import { parsePropfindResponse, parseQuotaFromPropfindResponse } from './xml';

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

export class WebDavClient {
  private serverUrl: string;
  private rootPath: string;
  private username?: string;
  private password?: string;
  private decodedPassword?: string;
  private allowInsecureTls: boolean;
  private defaultTimeoutMs: number;

  constructor(options: WebDavClientOptions) {
    const serverUrl = normalizeServerUrl(options.serverUrl);
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('服务器地址无效');
    }
    if (parsed.protocol === 'http:' && !options.allowInsecureHttp) {
      throw new Error('不允许使用不安全的 HTTP 连接');
    }

    this.serverUrl = serverUrl;
    this.rootPath = normalizeRootPath(options.rootPath);
    this.username = options.username;
    this.password = options.password;
    this.decodedPassword = options.password ? decodeMaybeBase64Password(options.password) : options.password;
    this.allowInsecureTls = !!options.allowInsecureTls;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
  }

  private buildUrl(path: string): string {
    const normalized = normalizeDavPath(path);
    const joinedPath = joinDavPaths(this.rootPath, normalized);
    const encodedPath = joinedPath
      .split('/')
      .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
      .join('/');
    return `${this.serverUrl}${encodedPath}`;
  }

  private buildAbsoluteUrl(path: string): string {
    const normalized = normalizeDavPath(path);
    const encodedPath = normalized
      .split('/')
      .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
      .join('/');
    return `${this.serverUrl}${encodedPath}`;
  }

  private buildHeaders(additional?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {};

    if (additional instanceof Headers) {
      additional.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(additional)) {
      additional.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else if (additional) {
      Object.entries(additional).forEach(([key, value]) => {
        if (value != null) {
          headers[key] = String(value);
        }
      });
    }

    if (this.username && this.decodedPassword !== undefined) {
      headers['Authorization'] = basicAuthHeaderValue(this.username, this.decodedPassword);
    }

    return headers;
  }

  private async requestText(
    path: string,
    options: {
      method: string;
      headers?: HeadersInit;
      body?: BodyInit | null;
      timeoutMs?: number;
    },
  ): Promise<WebDavResponse<string>> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(options.headers);

    const fetchImpl = isTauriAppPlatform() ? (tauriFetch as unknown as typeof fetch) : fetch;
    const requestInit: RequestInit & { danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean } } =
      {
        method: options.method,
        headers,
        body: options.body,
      };

    if (isTauriAppPlatform()) {
      requestInit.danger = {
        acceptInvalidCerts: this.allowInsecureTls,
        acceptInvalidHostnames: this.allowInsecureTls,
      };
    }

    try {
      const response = await withTimeout(fetchImpl(url, requestInit), options.timeoutMs ?? this.defaultTimeoutMs);
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        data: text,
        debug: `${options.method} ${url} -> ${response.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        headers: new Headers(),
        error: (e as Error).message || '请求失败',
        debug: `${options.method} ${url} -> ERROR ${(e as Error).message || '请求失败'}`,
      };
    }
  }

  private async requestBinary(
    path: string,
    options: {
      method: string;
      headers?: HeadersInit;
      body?: BodyInit | null;
      timeoutMs?: number;
    },
  ): Promise<WebDavResponse<ArrayBuffer>> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(options.headers);

    const fetchImpl = isTauriAppPlatform() ? (tauriFetch as unknown as typeof fetch) : fetch;
    const requestInit: RequestInit & { danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean } } =
      {
        method: options.method,
        headers,
        body: options.body,
      };

    if (isTauriAppPlatform()) {
      requestInit.danger = {
        acceptInvalidCerts: this.allowInsecureTls,
        acceptInvalidHostnames: this.allowInsecureTls,
      };
    }

    try {
      const response = await withTimeout(fetchImpl(url, requestInit), options.timeoutMs ?? this.defaultTimeoutMs);
      const data = await response.arrayBuffer();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        data,
        debug: `${options.method} ${url} -> ${response.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        headers: new Headers(),
        error: (e as Error).message || '请求失败',
        debug: `${options.method} ${url} -> ERROR ${(e as Error).message || '请求失败'}`,
      };
    }
  }

  private async requestAbsoluteText(
    absolutePath: string,
    options: {
      method: string;
      headers?: HeadersInit;
      body?: BodyInit | null;
      timeoutMs?: number;
    },
  ): Promise<WebDavResponse<string>> {
    const url = this.buildAbsoluteUrl(absolutePath);
    const headers = this.buildHeaders(options.headers);

    const fetchImpl = isTauriAppPlatform() ? (tauriFetch as unknown as typeof fetch) : fetch;
    const requestInit: RequestInit & { danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean } } = {
      method: options.method,
      headers,
      body: options.body,
    };

    if (isTauriAppPlatform()) {
      requestInit.danger = {
        acceptInvalidCerts: this.allowInsecureTls,
        acceptInvalidHostnames: this.allowInsecureTls,
      };
    }

    try {
      const response = await withTimeout(fetchImpl(url, requestInit), options.timeoutMs ?? this.defaultTimeoutMs);
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        data: text,
        debug: `${options.method} ${url} -> ${response.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        headers: new Headers(),
        error: (e as Error).message || '请求失败',
        debug: `${options.method} ${url} -> ERROR ${(e as Error).message || '请求失败'}`,
      };
    }
  }

  private async ensureRootPathHierarchy(rootPath: string = this.rootPath): Promise<WebDavResponse<void>> {
    const parts = rootPath.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current = `${current}/${part}`;
      const stat = await this.requestAbsoluteText(current, {
        method: 'PROPFIND',
        headers: { Depth: '0' },
      });
      if (stat.ok || stat.status === 207) {
        continue;
      }

      const created = await this.requestAbsoluteText(current, { method: 'MKCOL' });
      if (!(created.ok || created.status === 201 || created.status === 405)) {
        return {
          ok: false,
          status: created.status,
          headers: created.headers,
          error: created.error,
          debug: `ensure ${current} | ${stat.debug || ''} | ${created.debug || ''}`,
        };
      }
    }

    return { ok: true, status: 207, headers: new Headers(), debug: `ensure rootPath=${rootPath || '/'}` };
  }

  private async buildParentProbeDebug(rootPath: string = this.rootPath) {
    const parentPath = rootPath.split('/').slice(0, -1).join('/') || '/';
    const parentProbe = await this.propfindAbsolute(parentPath, { depth: '1' });
    const parentDebug = parentProbe.ok
      ? `${parentProbe.debug || ''} children=${(parentProbe.data || [])
          .map((item) => item.path)
          .filter(Boolean)
          .slice(0, 12)
          .join(',')}`
      : parentProbe.debug || '';
    return { parentDebug, parentPath };
  }

  private async probeRootPath(rootPath: string): Promise<WebDavResponse<void>> {
    const response = await this.requestAbsoluteText(rootPath || '/', {
      method: 'PROPFIND',
      headers: {
        Depth: '0',
      },
    });

    if (response.ok || response.status === 207) {
      return { ok: true, status: response.status, headers: response.headers, debug: response.debug, resolvedRootPath: rootPath };
    }

    if (response.status === 404 || response.status === 403) {
      const ensureResponse = await this.ensureRootPathHierarchy(rootPath);
      if (ensureResponse.ok) {
        return {
          ok: true,
          status: ensureResponse.status,
          headers: ensureResponse.headers,
          debug: `${response.debug || ''} | ${ensureResponse.debug || ''}`,
          resolvedRootPath: rootPath,
        };
      }
      return {
        ...ensureResponse,
        debug: `${response.debug || ''} | ${ensureResponse.debug || ''}`,
        resolvedRootPath: rootPath,
      };
    }

    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      error: response.error,
      debug: response.debug,
      resolvedRootPath: rootPath,
    };
  }

  async propfind(
    path: string,
    options?: { depth?: WebDavDepth; timeoutMs?: number; includeQuota?: boolean },
  ): Promise<WebDavResponse<WebDavPropfindResource[]>> {
    const depth = options?.depth ?? '1';
    const props = [
      'resourcetype',
      'getetag',
      'getlastmodified',
      'getcontentlength',
      ...(options?.includeQuota ? ['quota-used-bytes', 'quota-available-bytes'] : []),
    ];

    const body =
      `<?xml version=\"1.0\" encoding=\"utf-8\"?>` +
      `<d:propfind xmlns:d=\"DAV:\">` +
      `<d:prop>${props.map((p) => `<d:${p}/>`).join('')}</d:prop>` +
      `</d:propfind>`;

    const response = await this.requestText(path, {
      method: 'PROPFIND',
      timeoutMs: options?.timeoutMs,
      headers: {
        Depth: depth,
        Accept: 'application/xml',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body,
    });

    if (!response.ok || !response.data) {
      return { ok: false, status: response.status, headers: response.headers, error: response.error || '请求失败' };
    }

    try {
      const resources = parsePropfindResponse(response.data, {
        baseUrl: this.serverUrl,
        rootPath: this.rootPath,
      });
      return { ok: true, status: response.status, headers: response.headers, data: resources };
    } catch (e) {
      return { ok: false, status: response.status, headers: response.headers, error: (e as Error).message };
    }
  }

  async propfindAbsolute(
    absolutePath: string,
    options?: { depth?: WebDavDepth; timeoutMs?: number },
  ): Promise<WebDavResponse<WebDavPropfindResource[]>> {
    const depth = options?.depth ?? '1';
    const response = await this.requestAbsoluteText(absolutePath, {
      method: 'PROPFIND',
      timeoutMs: options?.timeoutMs,
      headers: {
        Depth: depth,
      },
    });

    if (!response.ok || !response.data) {
      return {
        ok: false,
        status: response.status,
        headers: response.headers,
        error: response.error || '请求失败',
        debug: response.debug,
      };
    }

    try {
      const resources = parsePropfindResponse(response.data, {
        baseUrl: this.serverUrl,
        rootPath: absolutePath,
      });
      return {
        ok: true,
        status: response.status,
        headers: response.headers,
        data: resources,
        debug: response.debug,
      };
    } catch (e) {
      return {
        ok: false,
        status: response.status,
        headers: response.headers,
        error: (e as Error).message,
        debug: response.debug,
      };
    }
  }

  async testConnection(): Promise<WebDavResponse<void>> {
    const directResponse = await this.probeRootPath(this.rootPath);
    if (directResponse.ok) {
      return directResponse;
    }

    const { parentDebug, parentPath } = await this.buildParentProbeDebug(this.rootPath);
    const parentChildren = parentDebug.match(/children=(.*)$/)?.[1] || '';
    const parentSegments = this.rootPath.split('/').filter(Boolean);
    const leafName = parentSegments[parentSegments.length - 1] || '';
    const hasWebDavNamespace = parentChildren.includes('/WebDAV/');

    if (hasWebDavNamespace && leafName && !this.rootPath.includes('/WebDAV/')) {
      const alternateRootPath = `${parentPath === '/' ? '' : parentPath}/WebDAV/${leafName}`;
      const alternateResponse = await this.probeRootPath(alternateRootPath);
      if (alternateResponse.ok) {
        return {
          ...alternateResponse,
          debug: `${directResponse.debug || ''}${parentDebug ? ` | parent ${parentPath}: ${parentDebug}` : ''} | alternate ${alternateResponse.debug || ''}`,
          resolvedRootPath: alternateRootPath,
        };
      }
      return {
        ...alternateResponse,
        debug: `${directResponse.debug || ''}${parentDebug ? ` | parent ${parentPath}: ${parentDebug}` : ''} | alternate ${alternateResponse.debug || ''}`,
        resolvedRootPath: alternateRootPath,
      };
    }

    return {
      ...directResponse,
      debug: `${directResponse.debug || ''}${parentDebug ? ` | parent ${parentPath}: ${parentDebug}` : ''}`,
    };
  }

  async getQuota(path: string = '/'): Promise<WebDavResponse<WebDavQuota>> {
    const response = await this.requestText(path, {
      method: 'PROPFIND',
      headers: {
        Depth: '0',
        Accept: 'application/xml',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body:
        `<?xml version=\"1.0\" encoding=\"utf-8\"?>` +
        `<d:propfind xmlns:d=\"DAV:\">` +
        `<d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop>` +
        `</d:propfind>`,
    });

    if (!response.ok || !response.data) {
      return { ok: false, status: response.status, headers: response.headers, error: response.error || '请求失败' };
    }

    try {
      return { ok: true, status: response.status, headers: response.headers, data: parseQuotaFromPropfindResponse(response.data) };
    } catch (e) {
      return { ok: false, status: response.status, headers: response.headers, error: (e as Error).message };
    }
  }

  async mkcol(path: string): Promise<WebDavResponse<void>> {
    const response = await this.requestText(path, { method: 'MKCOL' });
    const ok = response.ok || response.status === 405;
    return { ok, status: response.status, headers: response.headers, error: ok ? undefined : response.error };
  }

  async delete(path: string): Promise<WebDavResponse<void>> {
    const response = await this.requestText(path, { method: 'DELETE' });
    return { ok: response.ok, status: response.status, headers: response.headers, error: response.ok ? undefined : response.error };
  }

  async get(path: string, options?: { range?: { start: number; end?: number }; ifRange?: string }): Promise<WebDavResponse<ArrayBuffer>> {
    const headers: Record<string, string> = {};
    if (options?.range) {
      headers['Range'] = `bytes=${options.range.start}-${options.range.end ?? ''}`;
    }
    if (options?.ifRange) {
      headers['If-Range'] = options.ifRange;
    }
    return this.requestBinary(path, { method: 'GET', headers });
  }

  async put(
    path: string,
    body: BodyInit,
    options?: { contentType?: string; ifMatch?: string; ifNoneMatch?: string },
  ): Promise<WebDavResponse<void>> {
    const headers: Record<string, string> = {};
    if (options?.contentType) headers['Content-Type'] = options.contentType;
    if (options?.ifMatch) headers['If-Match'] = options.ifMatch;
    if (options?.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
    const response = await this.requestText(path, { method: 'PUT', headers, body });
    return { ok: response.ok, status: response.status, headers: response.headers, error: response.ok ? undefined : response.error };
  }

  async move(
    srcPath: string,
    destPath: string,
    options?: { overwrite?: boolean },
  ): Promise<WebDavResponse<void>> {
    const destinationUrl = this.buildUrl(destPath);
    const response = await this.requestText(srcPath, {
      method: 'MOVE',
      headers: {
        Destination: destinationUrl,
        Overwrite: options?.overwrite === false ? 'F' : 'T',
      },
    });
    return { ok: response.ok, status: response.status, headers: response.headers, error: response.ok ? undefined : response.error };
  }

  async copy(
    srcPath: string,
    destPath: string,
    options?: { overwrite?: boolean },
  ): Promise<WebDavResponse<void>> {
    const destinationUrl = this.buildUrl(destPath);
    const response = await this.requestText(srcPath, {
      method: 'COPY',
      headers: {
        Destination: destinationUrl,
        Overwrite: options?.overwrite === false ? 'F' : 'T',
      },
    });
    return { ok: response.ok, status: response.status, headers: response.headers, error: response.ok ? undefined : response.error };
  }
}
