/**
 * ascli ship <service> --stage <stage> [--env <env>] [--dirty]
 *
 * Build, publish, and deploy a service in one shot.
 * Always includes infrastructure: artifact → component:apply → CodeDeploy.
 */

import {
  discoverRoot,
  resolveEnvName,
} from "../lib/conventions.js";
import { resolveEngine } from "../lib/resolve-engine.js";
import { artifactCommand } from "./artifact.js";
import { deployCommand } from "./deploy.js";
import { componentApplyCommand } from "./component.js";

export type ShipOptions = {
  service: string;
  stage: string;
  envName?: string;
  dirty?: boolean;
  platform?: string;
};

export async function shipCommand(opts: ShipOptions): Promise<void> {
  const envName = resolveEnvName(opts.stage, opts.envName);

  console.log(`Shipping ${opts.service} → ${opts.stage}/${envName}\n`);

  const result = await artifactCommand({
    service: opts.service,
    stage: opts.stage,
    dirty: opts.dirty,
    platform: opts.platform,
  });

  const engine = resolveEngine();
  componentApplyCommand(
    {
      stage: opts.stage,
      envName,
      sha: result.artifactSha,
      component: opts.service,
      autoApprove: true,
    },
    engine,
  );

  await deployCommand({
    service: opts.service,
    stage: opts.stage,
    envName,
    sha: result.artifactSha,
    imageUri: result.type === "ecr" ? result.artifactUri : undefined,
  });

  console.log(`\nShipped: ${opts.service}@${result.artifactSha} → ${opts.stage}/${envName}`);
}
