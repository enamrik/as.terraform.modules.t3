/**
 * ascli init --stage <stage> --env <env>
 *
 * Generates _backend.tf and _provider.tf for all terraform roots
 * (system + discovered components) and runs terraform init.
 * Sets up IDE module resolution and local development.
 */

import { discoverRoot, discoverComponents, resolveTerraformRoot } from "../lib/conventions.js";
import { terraformInit } from "../lib/terraform.js";
import { existsSync } from "node:fs";

export type InitOptions = {
  stage: string;
  envName: string;
};

export function initCommand(opts: InitOptions): void {
  const root = discoverRoot(process.cwd());

  // System layer
  const systemDir = resolveTerraformRoot(root, "system");
  if (existsSync(`${systemDir}/main.tf`)) {
    console.log("── Initializing system layer ──");
    terraformInit({
      root,
      stage: opts.stage,
      envName: opts.envName,
      type: "system",
    });
  }

  // Components
  const components = discoverComponents(root);
  for (const service of components) {
    const componentDir = resolveTerraformRoot(root, "component", service);
    if (existsSync(`${componentDir}/main.tf`)) {
      console.log(`\n── Initializing component: ${service} ──`);
      terraformInit({
        root,
        stage: opts.stage,
        envName: opts.envName,
        type: "component",
        serviceName: service,
      });
    }
  }

  console.log("\nDone. Terraform modules downloaded, IDE should resolve all references.");
}
