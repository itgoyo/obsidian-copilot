import { requestUrl } from "obsidian";
import type { DeviceAuthSession, OAuthToken } from "../types";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const FETCH_TIMEOUT_MS = 30000;
const SLOW_DOWN_PENALTY_MS = 5000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenSuccessResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface AccessTokenErrorResponse {
  error:
    | "authorization_pending"
    | "slow_down"
    | "access_denied"
    | "expired_token"
    | "incorrect_client_credentials"
    | "incorrect_device_code"
    | "device_flow_disabled";
  error_description?: string;
  error_uri?: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

async function fetchWithTimeout<T>(
  requestPromise: Promise<T>,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<T> {
  let timer: number | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error("OAuth request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

function getAbortPromise(signal?: AbortSignal): Promise<never> | undefined {
  if (!signal) {
    return undefined;
  }

  if (signal.aborted) {
    return Promise.reject(new Error("Authorization was cancelled."));
  }

  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("Authorization was cancelled.")),
      { once: true }
    );
  });
}

async function postFormJson<T>(
  url: string,
  form: URLSearchParams,
  signal?: AbortSignal
): Promise<T> {
  let response: Awaited<ReturnType<typeof requestUrl>>;
  try {
    const requestPromise = fetchWithTimeout(
      requestUrl({
        url,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString(),
        throw: false
      })
    );

    const abortPromise = getAbortPromise(signal);
    response = abortPromise
      ? await Promise.race([requestPromise, abortPromise])
      : await requestPromise;
  } catch (error) {
    if (error instanceof Error && error.message === "Authorization was cancelled.") {
      throw error;
    }

    throw new Error(
      `Unable to connect to GitHub OAuth endpoint. Check network/proxy settings. (${String(error)})`
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OAuth request failed (${response.status}) at ${url}`);
  }

  if (response.json !== undefined) {
    return response.json as T;
  }

  if (!response.text) {
    throw new Error("OAuth request returned empty response.");
  }

  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error("OAuth endpoint returned invalid JSON response.");
  }
}

export class GitHubOAuthDeviceFlow {
  async startDeviceAuthorization(
    clientId: string,
    scopes: string
  ): Promise<DeviceAuthSession> {
    const params: Record<string, string> = { client_id: clientId };
    if (scopes) {
      params.scope = scopes;
    }

    const data = await postFormJson<DeviceCodeResponse>(
      DEVICE_CODE_URL,
      new URLSearchParams(params)
    );

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
      interval: data.interval,
      requestedAt: Date.now()
    };
  }

  async pollForAccessToken(
    clientId: string,
    session: DeviceAuthSession,
    signal?: AbortSignal
  ): Promise<OAuthToken> {
    const expiresAt = session.requestedAt + session.expiresIn * 1000;
    let intervalMs = session.interval * 1000;

    while (Date.now() < expiresAt) {
      if (signal?.aborted) {
        throw new Error("Authorization was cancelled.");
      }

      const payload = await postFormJson<
        AccessTokenSuccessResponse | AccessTokenErrorResponse
      >(
        ACCESS_TOKEN_URL,
        new URLSearchParams({
          client_id: clientId,
          device_code: session.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        signal
      );

      if ("access_token" in payload) {
        return {
          accessToken: payload.access_token,
          tokenType: payload.token_type,
          scope: payload.scope,
          createdAt: Date.now()
        };
      }

      if (payload.error === "authorization_pending") {
        await delay(intervalMs);
        continue;
      }

      if (payload.error === "slow_down") {
        intervalMs += SLOW_DOWN_PENALTY_MS;
        await delay(intervalMs);
        continue;
      }

      if (payload.error === "access_denied") {
        throw new Error("Authorization denied by user.");
      }

      if (payload.error === "expired_token") {
        throw new Error("Device code expired. Please restart login.");
      }

      throw new Error(payload.error_description || payload.error);
    }

    throw new Error("Device authorization timed out.");
  }
}
