/**
 * Resolves the IaC engine from .as.yml configuration.
 */

import type { IacEngine } from "./engine.js";
import { discoverRoot, resolveEngineName } from "./conventions.js";
import { TerraformEngine } from "./terraform.js";
import { PulumiEngine } from "./pulumi.js";

export function resolveEngine(): IacEngine {
  const root = discoverRoot(process.cwd());
  const name = resolveEngineName(root);

  switch (name) {
    case "pulumi":
      return new PulumiEngine();
    case "terraform":
      return new TerraformEngine();
    default:
      throw new Error(`Unknown engine "${name}" in .as.yml. Expected "terraform" or "pulumi".`);
  }
}
