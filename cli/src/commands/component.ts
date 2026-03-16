/**
 * ascli component:apply|component:destroy
 *
 * Component layer lifecycle.
 * - apply: create/update for one or all components (idempotent)
 * - destroy: destroy for one or all components
 */

import { discoverRoot, discoverComponents } from "../lib/conventions.js";
import type { IacEngine } from "../lib/engine.js";

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

export function componentApplyCommand(opts: ComponentApplyOptions, engine: IacEngine): void {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  for (const service of components) {
    console.log(`\n── Applying component: ${service} ──`);
    engine.apply({
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

export function componentDestroyCommand(opts: ComponentDestroyOptions, engine: IacEngine): void {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  for (const service of components) {
    console.log(`\n── Destroying component: ${service} ──`);
    engine.destroy({
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
