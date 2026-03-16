/**
 * ascli init --stage <stage> --env <env>
 *
 * Initializes infrastructure for all roots (system + discovered components).
 * What this means depends on the engine — terraform downloads modules,
 * pulumi installs dependencies.
 */

import { discoverRoot, discoverComponents } from "../lib/conventions.js";
import type { IacEngine } from "../lib/engine.js";

export type InitOptions = {
  stage: string;
  envName: string;
};

export function initCommand(opts: InitOptions, engine: IacEngine): void {
  const root = discoverRoot(process.cwd());

  console.log("── Initializing system layer ──");
  engine.init({
    root,
    stage: opts.stage,
    envName: opts.envName,
    type: "system",
  });

  const components = discoverComponents(root);
  for (const service of components) {
    console.log(`\n── Initializing component: ${service} ──`);
    engine.init({
      root,
      stage: opts.stage,
      envName: opts.envName,
      type: "component",
      serviceName: service,
    });
  }

  console.log(`\nDone. ${engine.name} initialized for all roots.`);
}
