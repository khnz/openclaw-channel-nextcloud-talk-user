import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveNextcloudTalkDeviceName } from "../device-login.js";

/**
 * HTTP client as the configured user with a shared sign-in state.
 *
 * A single 401 or brute-force throttling (429 "Reached maximum delay") stops the client
 * for all callers at once. After that no requests go out until the account is restarted
 * (new config).
 */

export class NextcloudTalkAuthStoppedError extends Error {
  constructor(readonly reason: "unauthorized" | "throttled") {
    super(
      reason === "unauthorized"
        ? "Nextcloud rejects the sign-in (app password revoked?). Receiving stopped; run the device login again."
        : "Nextcloud is throttling sign-ins from this IP (brute-force protection). Receiving stopped; admin: occ security:bruteforce:reset <IP>.",
    );
    this.name = "NextcloudTalkAuthStoppedError";
  }
}

export type NextcloudTalkResponse = {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
};

export type NextcloudTalkRequest = (params: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<NextcloudTalkResponse>;

export type NextcloudTalkClient = {
  readonly baseUrl: string;
  readonly user: string;
  request: NextcloudTalkRequest;
  /** Set once the sign-in has been stopped. */
  stopped(): NextcloudTalkAuthStoppedError | undefined;
  authorizationHeader(): string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export type NextcloudTalkRawHttp = (params: {
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
  timeoutMs: number;
}) => Promise<{ status: number; headers: Headers; text: string }>;

export function createNextcloudTalkGuardedRawHttp(allowPrivateNetwork: boolean | undefined): NextcloudTalkRawHttp {
  return async ({ url, init, signal, timeoutMs }) => {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init,
      timeoutMs,
      ...(signal ? { signal } : {}),
      policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
      auditContext: "nextcloud-talk-user-receive",
    });
    try {
      return { status: response.status, headers: response.headers, text: await response.text() };
    } finally {
      await release();
    }
  };
}

export function createNextcloudTalkClient(params: {
  baseUrl: string;
  user: string;
  appPassword: string;
  http: NextcloudTalkRawHttp;
  onStopped?: (error: NextcloudTalkAuthStoppedError) => void;
}): NextcloudTalkClient {
  const base = new URL(params.baseUrl);
  const authorization = `Basic ${Buffer.from(`${params.user}:${params.appPassword}`).toString("base64")}`;
  let stoppedError: NextcloudTalkAuthStoppedError | undefined;

  const stop = (reason: "unauthorized" | "throttled") => {
    if (!stoppedError) {
      stoppedError = new NextcloudTalkAuthStoppedError(reason);
      params.onStopped?.(stoppedError);
    }
    return stoppedError;
  };

  const request: NextcloudTalkRequest = async ({ method, path, query, form, headers, signal, timeoutMs }) => {
    if (stoppedError) {
      throw stoppedError;
    }
    const url = new URL(base.origin);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}${path}`;
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const response = await params.http({
      url: url.toString(),
      signal,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      init: {
        method,
        headers: {
          Accept: "application/json",
          "OCS-APIRequest": "true",
          "User-Agent": resolveNextcloudTalkDeviceName(),
          Authorization: authorization,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...headers,
        },
        ...(body ? { body } : {}),
      },
    });
    if (response.status === 401) {
      throw stop("unauthorized");
    }
    if (response.status === 429 && /maximum delay/iu.test(response.text)) {
      throw stop("throttled");
    }
    let json: unknown;
    try {
      json = response.text ? JSON.parse(response.text) : undefined;
    } catch {
      json = undefined;
    }
    return { ...response, json };
  };

  return {
    baseUrl: base.toString().replace(/\/+$/u, ""),
    user: params.user,
    request,
    stopped: () => stoppedError,
    authorizationHeader: () => authorization,
  };
}

/** `ocs.data` of an OCS response. */
export function readNextcloudTalkOcsData(response: NextcloudTalkResponse): unknown {
  const json = response.json as { ocs?: { data?: unknown } } | undefined;
  return json?.ocs?.data;
}
