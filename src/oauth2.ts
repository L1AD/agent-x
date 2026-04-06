import { randomBytes, createHash } from "crypto";
import { setSetting, getSettingValue } from "./db.js";
import { getKeys } from "./keys.js";
import { TwitterApi } from "twitter-api-v2";

let codeVerifier: string = "";
let stateParam: string = "";
let cachedClient: TwitterApi | null = null;
let cachedExpiresAt = 0;

const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "offline.access",
].join(" ");

function getClientCredentials() {
  const keys = getKeys();
  return {
    clientId: getSettingValue("x_client_id") || process.env.X_CLIENT_ID || keys.appKey,
    clientSecret: getSettingValue("x_client_secret") || process.env.X_CLIENT_SECRET || keys.appSecret,
  };
}

async function fetchToken(params: URLSearchParams): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const { clientId, clientSecret } = getClientCredentials();
  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${authHeader}`,
    },
    body: params.toString(),
  });

  const data = await resp.json() as any;
  if (!resp.ok) {
    return { ok: false, error: data.error_description || data.error || "Token request failed" };
  }
  return { ok: true, data };
}

function storeTokens(data: any) {
  setSetting.run({ key: "oauth2_access_token", value: data.access_token });
  if (data.refresh_token) {
    setSetting.run({ key: "oauth2_refresh_token", value: data.refresh_token });
  }
  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
  setSetting.run({ key: "oauth2_expires_at", value: String(expiresAt) });
  cachedClient = new TwitterApi(data.access_token);
  cachedExpiresAt = expiresAt;
}

export function getAuthUrl(redirectUri: string): string {
  const { clientId } = getClientCredentials();

  codeVerifier = randomBytes(32).toString("hex");
  stateParam = randomBytes(16).toString("hex");

  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state: stateParam,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `https://x.com/i/oauth2/authorize?${params}`;
}

export async function exchangeCode(
  code: string,
  state: string,
  redirectUri: string
): Promise<{ ok: boolean; error?: string; username?: string }> {
  if (state !== stateParam) {
    return { ok: false, error: "State mismatch" };
  }

  const { clientId } = getClientCredentials();

  try {
    const result = await fetchToken(new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }));

    if (!result.ok) return { ok: false, error: result.error };

    storeTokens(result.data);

    const me = await cachedClient!.v2.me();
    console.log(`[oauth2] Authenticated as @${me.data.username}`);
    return { ok: true, username: me.data.username };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function getOAuth2Client(): Promise<TwitterApi | null> {
  // Use cached client if still valid
  if (cachedClient && Date.now() < cachedExpiresAt - 5 * 60 * 1000) {
    return cachedClient;
  }

  const accessToken = getSettingValue("oauth2_access_token");
  if (!accessToken) return null;

  const expiresAt = parseInt(getSettingValue("oauth2_expires_at", "0"));

  // Token still valid, just wasn't cached
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    cachedClient = new TwitterApi(accessToken);
    cachedExpiresAt = expiresAt;
    return cachedClient;
  }

  // Needs refresh
  const refreshToken = getSettingValue("oauth2_refresh_token");
  if (!refreshToken) return null;

  const { clientId } = getClientCredentials();

  try {
    const result = await fetchToken(new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      client_id: clientId,
    }));

    if (!result.ok) {
      console.error("[oauth2] Refresh failed:", result.error);
      cachedClient = null;
      return null;
    }

    storeTokens(result.data);
    console.log("[oauth2] Token refreshed");
    return cachedClient;
  } catch (err: any) {
    console.error("[oauth2] Refresh error:", err.message);
    cachedClient = null;
    return null;
  }
}
