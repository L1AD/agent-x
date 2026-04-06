import "dotenv/config";
import { getKeys } from "./keys.js";
import { startStream } from "./stream.js";
import { startServer } from "./server.js";

const keys = getKeys();

// Make Anthropic key available to the SDK
if (keys.anthropicKey) {
  process.env.ANTHROPIC_API_KEY = keys.anthropicKey;
}

console.log("[agent-x] Starting...");
await startServer(3000);

// Start polling if we have the required keys
if (keys.bearerToken && keys.anthropicKey) {
  await startStream(keys.bearerToken);
} else {
  const missing = [];
  if (!keys.bearerToken) missing.push("X Bearer Token");
  if (!keys.anthropicKey) missing.push("Anthropic API Key");
  console.log(`[agent-x] ${missing.join(" and ")} not set. Configure in Settings, then restart.`);
}

process.on("SIGINT", () => {
  console.log("\n[agent-x] Shutting down...");
  process.exit(0);
});
