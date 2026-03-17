/**
 * as build <service>
 *
 * Builds a service artifact locally.
 * - Lambda Zip: runs esbuild → dist/
 * - Lambda Image / ECS: runs docker build → local image
 */

import { existsSync } from "node:fs";
import { exec, resolveArtifactSha } from "../lib/shell.js";
import { resolveServiceDir, discoverRoot } from "../lib/conventions.js";

export type BuildOptions = {
  service: string;
  platform?: string;
  dirty?: boolean;
};

export type BuildResult = {
  service: string;
  type: "zip" | "image";
  localPath: string;
  sha: string;
};

function detectBuildType(serviceDir: string): "zip" | "image" {
  if (existsSync(`${serviceDir}/Dockerfile`)) return "image";
  return "zip";
}

function buildZip(serviceDir: string): void {
  console.log("Running esbuild...");
  exec(`rm -rf ${serviceDir}/dist`);
  exec(
    [
      "npx esbuild",
      `${serviceDir}/src/handler.ts`,
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=esm",
      `--outdir=${serviceDir}/dist`,
      "--out-extension:.js=.mjs",
      "--sourcemap",
      "--minify",
      "--tree-shaking=true",
      "--external:@aws-sdk/*",
      `--tsconfig=${serviceDir}/tsconfig.json`,
      '--banner:js="import { createRequire } from \'module\'; const require = createRequire(import.meta.url);"',
    ].join(" "),
    { cwd: serviceDir },
  );
}

function buildImage(serviceDir: string, sha: string, platform: string): void {
  const tag = `${serviceDir.split("/").pop()}:${sha}`;

  console.log(`Building Docker image: ${tag}`);
  exec(
    [
      "docker build",
      `--platform linux/${platform}`,
      "--provenance=false",
      `-t ${tag}`,
      serviceDir,
    ].join(" "),
    { cwd: serviceDir },
  );
}

export function buildCommand(opts: BuildOptions): BuildResult {
  const root = discoverRoot(process.cwd());
  const serviceDir = resolveServiceDir(root, opts.service);
  const buildType = detectBuildType(serviceDir);
  const platform = opts.platform ?? "arm64";
  const allowDirty = opts.dirty ?? false;

  if (buildType === "zip") {
    buildZip(serviceDir);
    const sha = resolveArtifactSha(root, `${serviceDir}/dist`, allowDirty);
    console.log(`Built ${opts.service} (zip) @ ${sha}`);
    return { service: opts.service, type: "zip", localPath: `${serviceDir}/dist`, sha };
  }

  const sha = resolveArtifactSha(root, serviceDir, allowDirty);
  console.log(`Building ${opts.service} (image) @ ${sha}`);
  buildImage(serviceDir, sha, platform);
  return {
    service: opts.service,
    type: "image",
    localPath: `${opts.service}:${sha}`,
    sha,
  };
}
