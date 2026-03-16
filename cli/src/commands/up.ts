/**
 * ascli up --stage <stage> --env <env> [-y] [--from <env>] [--dirty]
 *
 * Stand up an environment from nothing.
 * env:apply → artifact all → component:apply all
 *
 * With --from: clone tagged SHAs from a source environment (no build needed).
 */

import {
  discoverRoot,
  discoverComponents,
  resolveDeploymentsTable,
  resolveEnvName,
  resolveProfile,
  resolveRegion,
  resolveSystem,
} from "../lib/conventions.js";
import { resolveEngine } from "../lib/resolve-engine.js";
import { gitShortSha } from "../lib/shell.js";
import { Manifest } from "../lib/manifest.js";
import { envApplyCommand } from "./env.js";
import { artifactCommand } from "./artifact.js";
import { componentApplyCommand } from "./component.js";

export type UpOptions = {
  stage: string;
  envName?: string;
  yes?: boolean;
  from?: string;
  dirty?: boolean;
};

export async function upCommand(opts: UpOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);
  const engine = resolveEngine();

  console.log(`Standing up environment: ${opts.stage}/${envName}\n`);

  // 1. Apply system layer
  envApplyCommand(
    { stage: opts.stage, envName, autoApprove: opts.yes },
    engine,
  );

  const services = discoverComponents(root);

  if (opts.from) {
    // Clone from source: read TAG records for each service at source stage
    const region = resolveRegion(root, opts.stage);
    const profile = resolveProfile(root, opts.stage);
    const tableName = resolveDeploymentsTable(root, opts.stage);
    const system = resolveSystem(root);
    const manifest = new Manifest(tableName, region, system, profile);

    const tags = await manifest.getAllServiceTags(opts.from, services);

    console.log(`\nCloning from "${opts.from}" tag (${tags.length} service(s))\n`);

    for (const tag of tags) {
      console.log(`  ${tag.service}@${tag.sha}`);
      componentApplyCommand(
        {
          stage: opts.stage,
          envName,
          sha: tag.sha,
          component: tag.service,
          autoApprove: opts.yes,
        },
        engine,
      );
    }
  } else {
    // Build everything from HEAD
    const sha = gitShortSha(root);
    console.log(`\nBuilding ${services.length} service(s) @ ${sha}\n`);

    for (const service of services) {
      await artifactCommand({
        service,
        stage: opts.stage,
        dirty: opts.dirty,
      });
    }

    componentApplyCommand(
      {
        stage: opts.stage,
        envName,
        sha,
        autoApprove: opts.yes,
      },
      engine,
    );
  }

  console.log(`\nEnvironment ready: ${opts.stage}/${envName}`);
}
