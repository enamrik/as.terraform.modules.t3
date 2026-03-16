/**
 * Conventions — reads .as.yml from the repo root to resolve
 * stage profiles, state buckets, artifact locations, and directory structure.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { sep, basename } from "node:path";
import { parse } from "yaml";

type StageConfig = {
  profile: string;
  region: string;
};

type AsConfig = {
  system: string;
  engine?: "terraform" | "pulumi";
  stages: Record<string, StageConfig>;
  stateBucket: string;
  artifactBucket: string;
  deploymentsTable: string;
};

const IAC_DIR = "infra";

let cachedConfig: { root: string; config: AsConfig } | null = null;

function loadConfig(root: string): AsConfig {
  if (cachedConfig?.root === root) return cachedConfig.config;

  const configPath = `${root}/.as.yml`;
  if (!existsSync(configPath)) {
    throw new Error(`No .as.yml found at ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = parse(raw) as AsConfig;
  cachedConfig = { root: root, config };
  return config;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function getStage(config: AsConfig, stage: string): StageConfig {
  const stageConfig = config.stages[stage];
  if (!stageConfig) {
    throw new Error(
      `Stage "${stage}" not found in .as.yml. Available: ${Object.keys(config.stages).join(", ")}`,
    );
  }
  return stageConfig;
}

export function resolveSystem(root: string): string {
  const config = loadConfig(root);
  if (!config.system) {
    throw new Error("Missing 'system' field in .as.yml");
  }
  return config.system;
}

export function resolveEngineName(root: string): "terraform" | "pulumi" {
  const config = loadConfig(root);
  return config.engine ?? "terraform";
}

export function resolveProfile(root: string, stage: string): string {
  return getStage(loadConfig(root), stage).profile;
}

export function resolveRegion(root: string, stage: string): string {
  return getStage(loadConfig(root), stage).region;
}

export function resolveStateBucket(root: string, stage: string): string {
  const config = loadConfig(root);
  const stageConfig = getStage(config, stage);
  return interpolate(config.stateBucket, { profile: stageConfig.profile, stage });
}

export function resolveArtifactBucket(root: string, stage: string): string {
  const config = loadConfig(root);
  return interpolate(config.artifactBucket, { stage });
}

export function resolveDeploymentsTable(root: string, stage: string): string {
  const config = loadConfig(root);
  return interpolate(config.deploymentsTable, { stage });
}

export function resolveStateKey(
  type: "system" | "component",
  envName: string,
  serviceName?: string,
): string {
  if (type === "system") {
    return `state/system/${envName}/terraform.tfstate`;
  }
  return `state/${serviceName}/${envName}/terraform.tfstate`;
}

export function resolveArtifactKey(serviceName: string, sha: string, ext: string): string {
  return `${serviceName}/${sha}.${ext}`;
}

export function resolveEcrRepo(root: string, serviceName: string): string {
  const system = resolveSystem(root);
  return `${system}/${serviceName}`;
}

export function resolveIacRoot(
  root: string,
  type: "system" | "component",
  serviceName?: string,
): string {
  if (type === "system") {
    return `${root}/${IAC_DIR}`;
  }
  return `${root}/apps/${serviceName}/${IAC_DIR}`;
}

export function resolveServiceDir(root: string, serviceName: string): string {
  return `${root}/apps/${serviceName}`;
}

export function discoverComponents(root: string): string[] {
  const appsDir = `${root}/apps`;
  if (!existsSync(appsDir)) return [];

  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => {
      if (!d.isDirectory()) return false;
      const dir = `${appsDir}/${d.name}`;
      const hasIac =
        existsSync(`${dir}/${IAC_DIR}/main.tf`) ||
        existsSync(`${dir}/${IAC_DIR}/index.ts`);
      const hasBuildable =
        existsSync(`${dir}/src/handler.ts`) || existsSync(`${dir}/Dockerfile`);
      return hasIac && hasBuildable;
    })
    .map((d) => d.name);
}

export function resolveTfvarsFile(terraformRoot: string, stage: string): string | null {
  const path = `${terraformRoot}/configs/${stage}.tfvars`;
  return existsSync(path) ? path : null;
}

export function discoverRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== sep && dir !== "") {
    if (existsSync(`${dir}/.as.yml`)) return dir;
    const parent = dir.substring(0, dir.lastIndexOf(sep)) || sep;
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find .as.yml in any parent directory");
}
