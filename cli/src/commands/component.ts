/**
 * as component apply|destroy
 *
 * Component layer terraform.
 * - apply: terraform apply for one or all components (idempotent)
 * - destroy: terraform destroy for one or all components
 */

import { discoverRoot, discoverComponents } from "../lib/conventions.js";
import { terraformRun } from "../lib/terraform.js";

export type ComponentApplyOptions = {
  stage: string;
  envName: string;
  sha: string;
  component?: string;
  autoApprove?: boolean;
};

export type ComponentDestroyOptions = {
  stage: string;
  envName: string;
  component?: string;
  autoApprove?: boolean;
};

export function componentApplyCommand(opts: ComponentApplyOptions): void {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  for (const service of components) {
    console.log(`\n── Applying component: ${service} ──`);
    terraformRun("apply", {
      root,
      stage: opts.stage,
      envName: opts.envName,
      type: "component",
      serviceName: service,
      vars: { sha: opts.sha },
      autoApprove: opts.autoApprove,
    });
  }
}

export function componentDestroyCommand(opts: ComponentDestroyOptions): void {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  for (const service of components) {
    console.log(`\n── Destroying component: ${service} ──`);
    terraformRun("destroy", {
      root,
      stage: opts.stage,
      envName: opts.envName,
      type: "component",
      serviceName: service,
      vars: { sha: "destroying" },
      autoApprove: opts.autoApprove,
    });
  }
}
