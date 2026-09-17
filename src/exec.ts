import { spawn } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface Exec {
  run(command: string, args: string[]): Promise<ExecResult>;
}

/** Real subprocess runner; never throws — failures are returned as results. */
export function nodeExec(): Exec {
  return {
    run(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (err) => {
          resolve({ ok: false, code: null, stdout, stderr, error: String(err) });
        });
        child.on("close", (code) => {
          resolve({ ok: code === 0, code, stdout, stderr, error: null });
        });
      });
    },
  };
}
