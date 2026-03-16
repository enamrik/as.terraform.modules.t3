/**
 * ascli down --stage <stage> --env <env> [-y]
 *
 * Tear down an environment completely.
 * component:destroy all → env:destroy (system layer + manifest cleanup)
 */

import { resolveEnvName } from "../lib/conventions.js";
import { resolveEngine } from "../lib/resolve-engine.js";
import { componentDestroyCommand } from "./component.js";
import { envDestroyCommand } from "./env.js";

export type DownOptions = {
  stage: string;
  envName?: string;
  yes?: boolean;
};

export async function downCommand(opts: DownOptions): Promise<void> {
  const envName = resolveEnvName(opts.stage, opts.envName);
  const engine = resolveEngine();

  console.log(`Tearing down environment: ${opts.stage}/${envName}\n`);

  componentDestroyCommand(
    { stage: opts.stage, envName, autoApprove: opts.yes },
    engine,
  );

  await envDestroyCommand(
    { stage: opts.stage, envName, autoApprove: opts.yes },
    engine,
  );

  console.log(`\nEnvironment destroyed: ${opts.stage}/${envName}`);
}
