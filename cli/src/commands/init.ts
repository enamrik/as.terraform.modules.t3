/**
 * ascli init [--stage <stage>] [--env <env>]
 *
 * Idempotent project initialization:
 * 1. Creates .as.yml if missing
 * 2. Reconciles component statics (ECR repos from .as.service.yml)
 * 3. Optionally runs IaC init for env + component layers
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, sep } from "node:path";
import { discoverRoot, discoverComponents, resolveEnvName } from "../lib/conventions.js";
import { reconcileEcrRepos } from "../lib/ecr.js";
import type { IacEngine } from "../lib/engine.js";

export type InitOptions = {
  stage?: string;
  envName?: string;
  system?: string;
};

export function initCommand(opts: InitOptions, engine?: IacEngine): void {
  const root = findProjectRoot(process.cwd());

  // 1. Create .as.yml if it doesn't exist
  const configPath = `${root}/.as.yml`;
  if (!existsSync(configPath)) {
    const system = opts.system ?? basename(root);
    writeFileSync(
      configPath,
      `system: ${system}\n`,
    );
    console.log(`Created ${configPath} (system: ${system})`);
    console.log("Foundation defaults apply — override stages in .as.yml if needed.\n");
  } else {
    console.log(`.as.yml already exists at ${configPath}\n`);
  }

  // 2. Reconcile component statics (ECR repos)
  if (opts.stage) {
    console.log("── Reconciling component statics ──");
    reconcileEcrRepos(root, opts.stage);
    console.log();
  }

  // 3. If --stage provided, also run IaC init
  if (opts.stage && engine) {
    const envName = resolveEnvName(opts.stage, opts.envName);

    console.log("── Initializing env layer ──");
    engine.init({
      root,
      stage: opts.stage,
      envName,
      type: "env",
    });

    const components = discoverComponents(root);
    for (const service of components) {
      console.log(`\n── Initializing component: ${service} ──`);
      engine.init({
        root,
        stage: opts.stage,
        envName,
        type: "component",
        serviceName: service,
      });
    }

    console.log(`\nDone. ${engine.name} initialized for all roots.`);
  }
}

function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== sep && dir !== "") {
    if (existsSync(`${dir}/.as.yml`) || existsSync(`${dir}/.git`)) return dir;
    const parent = dir.substring(0, dir.lastIndexOf(sep)) || sep;
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
