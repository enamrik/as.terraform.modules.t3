/**
 * ascli component:apply|component:destroy
 *
 * Component layer lifecycle.
 * - apply: create/update for one or all components (idempotent)
 * - destroy: destroy for one or all components
 *
 * When operating on multiple components, runs them in parallel.
 */

import { discoverRoot, discoverComponents } from "../lib/conventions.js";
import type { IacEngine } from "../lib/engine.js";

export type ComponentApplyOptions = {
  stage: string;
  envName: string;
  sha: string;
  component?: string;
  autoApprove?: boolean;
  artifactVars?: Record<string, Record<string, string>>;
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
      vars: { sha: opts.sha, ...opts.artifactVars?.[service] },
      autoApprove: opts.autoApprove,
    });
  }
}

export async function componentApplyParallel(opts: ComponentApplyOptions, engine: IacEngine): Promise<void> {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  console.log(`\n── Applying ${components.length} components in parallel ──`);

  const results = await Promise.allSettled(
    components.map((service) =>
      engine.applyAsync({
        root,
        stage: opts.stage,
        envName: opts.envName,
        type: "component",
        serviceName: service,
        vars: { sha: opts.sha, ...opts.artifactVars?.[service] },
        autoApprove: opts.autoApprove,
        prefix: service,
      }),
    ),
  );

  const failed = results
    .map((r, i) => ({ result: r, service: components[i] }))
    .filter((r) => r.result.status === "rejected");

  if (failed.length > 0) {
    console.error(`\n${failed.length} component(s) failed:`);
    for (const f of failed) {
      console.error(`  ✗ ${f.service}: ${(f.result as PromiseRejectedResult).reason}`);
    }
    throw new Error(`${failed.length} component(s) failed to apply`);
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

export async function componentDestroyParallel(opts: ComponentDestroyOptions, engine: IacEngine): Promise<void> {
  const root = discoverRoot(process.cwd());
  const components = opts.component ? [opts.component] : discoverComponents(root);

  console.log(`\n── Destroying ${components.length} components in parallel ──`);

  const results = await Promise.allSettled(
    components.map((service) =>
      engine.destroyAsync({
        root,
        stage: opts.stage,
        envName: opts.envName,
        type: "component",
        serviceName: service,
        vars: { sha: "destroying" },
        autoApprove: opts.autoApprove,
        prefix: service,
      }),
    ),
  );

  const failed = results
    .map((r, i) => ({ result: r, service: components[i] }))
    .filter((r) => r.result.status === "rejected");

  if (failed.length > 0) {
    console.error(`\n${failed.length} component(s) failed to destroy:`);
    for (const f of failed) {
      console.error(`  ✗ ${f.service}: ${(f.result as PromiseRejectedResult).reason}`);
    }
    throw new Error(`${failed.length} component(s) failed to destroy`);
  }
}
