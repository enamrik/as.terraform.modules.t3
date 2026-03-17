/**
 * Conventions — merges foundation defaults with optional .as.yml overrides.
 *
 * Resolution order: foundation defaults ← .as.yml overrides
 * .as.yml is optional — without it, ascli uses foundation defaults,
 * system name defaults to the root folder name, engine defaults to pulumi.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { sep, basename } from "node:path";
import { parse } from "yaml";
import { FOUNDATION } from "./foundation.js";

type StageConfig = {
  profile: string;
  region: string;
};

type AsConfig = {
  system?: string;
  engine?: "terraform" | "pulumi";
  stages?: Record<string, Partial<StageConfig>>;
  stateBucket?: string;
  artifactBucket?: string;
  deploymentsTable?: string;
};

type ResolvedConfig = {
  system: string;
  engine: "terraform" | "pulumi";
  stages: Record<string, StageConfig>;
  stateBucket: string;
  artifactBucket: string;
  deploymentsTable: string;
};

const IAC_DIR = "infra";

let cachedConfig: { root: string; config: ResolvedConfig } | null = null;

function mergeConfig(root: string, overrides: AsConfig): ResolvedConfig {
  const stages: Record<string, StageConfig> = {};

  for (const [name, defaults] of Object.entries(FOUNDATION.stages)) {
    const override = overrides.stages?.[name];
    stages[name] = {
      profile: override?.profile ?? defaults.profile,
      region: override?.region ?? defaults.region,
    };
  }

  // Allow .as.yml to define stages not in foundation (e.g. a custom test stage)
  if (overrides.stages) {
    for (const [name, override] of Object.entries(overrides.stages)) {
      if (!stages[name]) {
        if (!override.profile || !override.region) {
          throw new Error(
            `Custom stage "${name}" in .as.yml must define both profile and region`,
          );
        }
        stages[name] = { profile: override.profile, region: override.region };
      }
    }
  }

  return {
    system: overrides.system ?? basename(root),
    engine: overrides.engine ?? "pulumi",
    stages,
    stateBucket: overrides.stateBucket ?? FOUNDATION.stateBucket,
    artifactBucket: overrides.artifactBucket ?? FOUNDATION.artifactBucket,
    deploymentsTable: overrides.deploymentsTable ?? FOUNDATION.deploymentsTable,
  };
}

function loadConfig(root: string): ResolvedConfig {
  if (cachedConfig?.root === root) return cachedConfig.config;

  const configPath = `${root}/.as.yml`;
  let overrides: AsConfig = {};

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    overrides = (parse(raw) as AsConfig) ?? {};
  }

  const config = mergeConfig(root, overrides);
  cachedConfig = { root, config };
  return config;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function getStage(config: ResolvedConfig, stage: string): StageConfig {
  const stageConfig = config.stages[stage];
  if (!stageConfig) {
    throw new Error(
      `Stage "${stage}" not found. Available: ${Object.keys(config.stages).join(", ")}`,
    );
  }
  return stageConfig;
}

export function resolveSystem(root: string): string {
  return loadConfig(root).system;
}

export function resolveEngineName(root: string): "terraform" | "pulumi" {
  return loadConfig(root).engine;
}

export function resolveProfile(root: string, stage: string): string {
  return getStage(loadConfig(root), stage).profile;
}

export function awsProfileFlag(root: string, stage: string): string {
  if (process.env.AWS_ACCESS_KEY_ID) return "";
  return `--profile ${resolveProfile(root, stage)}`;
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
  return interpolate(config.artifactBucket, { stage, system: config.system });
}

export function resolveDeploymentsTable(root: string, stage: string): string {
  const config = loadConfig(root);
  return interpolate(config.deploymentsTable, { stage });
}

export function resolveStateKey(
  type: "env" | "component",
  envName: string,
  serviceName?: string,
): string {
  if (type === "env") {
    return `state/env/${envName}/terraform.tfstate`;
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
  type: "env" | "component",
  serviceName?: string,
): string {
  if (type === "env") {
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

export function resolveEnvName(stage: string, envFromFlag: string | undefined): string {
  if (envFromFlag) return envFromFlag;
  if (stage !== "dev") return stage;
  throw new Error(
    `--env is required for stage "dev" (dev environments are always ephemeral)`,
  );
}

export const DEFAULT_STAGE = "dev";

export function discoverRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== sep && dir !== "") {
    // .as.yml is optional now — fall back to git root
    if (existsSync(`${dir}/.as.yml`) || existsSync(`${dir}/.git`)) return dir;
    const parent = dir.substring(0, dir.lastIndexOf(sep)) || sep;
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find project root (no .as.yml or .git found)");
}
