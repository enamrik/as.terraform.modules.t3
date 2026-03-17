/**
 * Reads .as.service.yml files from component directories.
 *
 * These declare component statics — resources that survive environment
 * teardown and are shared across all envs (e.g., ECR repos).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";

export type ServiceConfig = {
  name: string;
  ecr_repo?: string;
};

export function discoverServiceConfigs(root: string): ServiceConfig[] {
  const appsDir = `${root}/apps`;
  if (!existsSync(appsDir)) return [];

  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const configPath = `${appsDir}/${d.name}/.as.service.yml`;
      if (!existsSync(configPath)) return [];
      const raw = readFileSync(configPath, "utf-8");
      const parsed = (parse(raw) as Record<string, unknown>) ?? {};
      return [{
        name: d.name,
        ecr_repo: typeof parsed.ecr_repo === "string" ? parsed.ecr_repo : undefined,
      }];
    });
}
