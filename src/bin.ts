#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main, nodeSpawn } from "./cli.js";

try {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    spawn: nodeSpawn,
    entryPath: fileURLToPath(new URL("./bin.js", import.meta.url)),
  });
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
