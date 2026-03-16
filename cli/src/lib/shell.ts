/**
 * Shell execution helpers — runs terraform, esbuild, docker, and aws CLI commands.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  silent?: boolean;
};

export function exec(command: string, opts: ExecOptions = {}): string {
  const execOpts: ExecSyncOptions = {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf-8",
  };

  if (opts.silent) {
    return execSync(command, execOpts) as string;
  }

  execSync(command, execOpts);
  return "";
}

export function gitShortSha(cwd?: string): string {
  return exec("git rev-parse --short HEAD", { cwd, silent: true }).trim();
}

export function gitFullSha(cwd?: string): string {
  return exec("git rev-parse HEAD", { cwd, silent: true }).trim();
}
