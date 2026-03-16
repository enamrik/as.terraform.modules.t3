/**
 * ascli ship <service> --stage <stage> [--env <env>] [--infra] [--dirty]
 *
 * Build, publish, and deploy a service in one shot.
 * Default: artifact → CodeDeploy (fast code path).
 * With --infra: artifact → component:apply (infrastructure changes).
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
  infra?: boolean;
  dirty?: boolean;
};

export async function shipCommand(opts: ShipOptions): Promise<void> {
  const envName = resolveEnvName(opts.stage, opts.envName);

  console.log(`Shipping ${opts.service} → ${opts.stage}/${envName}${opts.infra ? " (infra)" : ""}\n`);

  const result = await artifactCommand({
    service: opts.service,
    stage: opts.stage,
    dirty: opts.dirty,
  });

  if (opts.infra) {
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
  } else {
    await deployCommand({
      service: opts.service,
      stage: opts.stage,
      envName,
      sha: result.artifactSha,
    });
  }

  console.log(`\nShipped: ${opts.service}@${result.artifactSha} → ${opts.stage}/${envName}`);
}
