import { getSettingValue } from "./db.js";

function getKey(dbKey: string, envKey: string): string {
  return getSettingValue(dbKey) || process.env[envKey] || "";
}

export function getKeys() {
  return {
    bearerToken: getKey("x_bearer_token", "X_BEARER_TOKEN"),
    appKey: getKey("x_app_key", "X_APP_KEY"),
    appSecret: getKey("x_app_secret", "X_APP_SECRET"),
    accessToken: getKey("x_access_token", "X_ACCESS_TOKEN"),
    accessSecret: getKey("x_access_secret", "X_ACCESS_SECRET"),
    anthropicKey: getKey("anthropic_api_key", "ANTHROPIC_API_KEY"),
  };
}
