/**
 * Shell execution helpers — runs terraform, esbuild, docker, and aws CLI commands.
 */

import { execSync, spawn, type ExecSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

export function execAsync(
  command: string,
  opts: ExecOptions & { prefix?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const prefix = opts.prefix ? `[${opts.prefix}] ` : "";
    const child = spawn("sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.silent ? "pipe" : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (!opts.silent) {
        for (const line of text.split("\n")) {
          if (line) process.stdout.write(`${prefix}${line}\n`);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (!opts.silent) {
        for (const line of text.split("\n")) {
          if (line) process.stderr.write(`${prefix}${line}\n`);
        }
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${command}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function gitShortSha(cwd?: string): string {
  return exec("git rev-parse --short HEAD", { cwd, silent: true }).trim();
}

export function gitFullSha(cwd?: string): string {
  return exec("git rev-parse HEAD", { cwd, silent: true }).trim();
}

export function isDirty(cwd?: string): boolean {
  const output = exec("git status --porcelain", { cwd, silent: true }).trim();
  return output.length > 0;
}

export function username(): string {
  if (process.env.USER) return process.env.USER;
  try {
    return exec("whoami", { silent: true }).trim();
  } catch {
    return "unknown";
  }
}

export function contentHash(dir: string): string {
  const hash = createHash("sha256");
  const files = collectFiles(dir).sort();
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").substring(0, 8);
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function resolveArtifactSha(
  root: string,
  distDir: string,
  allowDirty: boolean,
): string {
  if (!isDirty(root)) return gitShortSha(root);
  if (!allowDirty) {
    throw new Error(
      "Working tree is dirty. Commit your changes or use --dirty to build with a content-hashed SHA.",
    );
  }
  return `dev-${username()}-${contentHash(distDir)}`;
}

export function detectDeployer(): string {
  if (process.env.GITHUB_ACTIONS) {
    return `github-actions/${process.env.GITHUB_RUN_ID ?? "unknown"}`;
  }
  return `local/${username()}`;
}
