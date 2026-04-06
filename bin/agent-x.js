#!/usr/bin/env node

import { execSync, spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Run with tsx
const tsx = join(root, "node_modules", ".bin", "tsx");
const entry = join(root, "src", "index.ts");

const child = spawn(tsx, [entry], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env },
});

child.on("exit", (code) => process.exit(code ?? 0));
