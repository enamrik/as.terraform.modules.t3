/**
 * ascli up --stage <stage> --env <env> [-y] [--from <env>] [--dirty]
 *
 * Stand up an environment from nothing.
 * env:apply → artifact all (parallel) → component:apply all (parallel) → deploy Lambda services (parallel)
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
  resolveServiceDir,
  resolveSystem,
} from "../lib/conventions.js";
import { existsSync } from "node:fs";
import { resolveEngine } from "../lib/resolve-engine.js";
import { gitShortSha } from "../lib/shell.js";
import { Manifest } from "../lib/manifest.js";
import { reconcileEcrRepos } from "../lib/ecr.js";
import { envApplyCommand } from "./env.js";
import { artifactCommand } from "./artifact.js";
import { componentApplyParallel } from "./component.js";
import { deployCommand } from "./deploy.js";

export type UpOptions = {
  stage: string;
  envName?: string;
  yes?: boolean;
  from?: string;
  dirty?: boolean;
  platform?: string;
};

export async function upCommand(opts: UpOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);
  const engine = resolveEngine();

  console.log(`Standing up environment: ${opts.stage}/${envName}\n`);

  // 1. Reconcile component statics (ECR repos)
  console.log("── Reconciling component statics ──");
  reconcileEcrRepos(root, opts.stage);
  console.log();

  // 2. Apply env layer (API Gateway, domain, etc.)
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
    }

    const artifactVars = Object.fromEntries(
      tags.map((t) => [t.service, { sha: t.sha }]),
    );

    await componentApplyParallel(
      {
        stage: opts.stage,
        envName,
        sha: tags[0]?.sha ?? "unknown",
        autoApprove: opts.yes,
        artifactVars,
      },
      engine,
    );

    // Deploy Lambda services to shift aliases and write manifest
    await deployLambdaServices(root, services, opts.stage, envName, artifactVars);
  } else {
    // Build everything from HEAD (parallel)
    const sha = gitShortSha(root);
    console.log(`\nBuilding ${services.length} service(s) @ ${sha}\n`);

    const artifactResults = await Promise.all(
      services.map((service) =>
        artifactCommand({
          service,
          stage: opts.stage,
          dirty: opts.dirty,
          platform: opts.platform,
        }).then((result) => ({ service, result })),
      ),
    );

    const artifactVars: Record<string, Record<string, string>> = {};
    for (const { service, result } of artifactResults) {
      artifactVars[service] = { sha: result.artifactSha };
      if (result.type === "ecr") {
        artifactVars[service].imageUri = result.artifactUri;
      }
    }

    // Apply all component infrastructure in parallel
    await componentApplyParallel(
      {
        stage: opts.stage,
        envName,
        sha,
        autoApprove: opts.yes,
        artifactVars,
      },
      engine,
    );

    // Deploy Lambda services to shift aliases and write manifest
    await deployLambdaServices(root, services, opts.stage, envName, artifactVars);
  }

  console.log(`\nEnvironment ready: ${opts.stage}/${envName}`);
}

async function deployLambdaServices(
  root: string,
  services: string[],
  stage: string,
  envName: string,
  artifactVars: Record<string, Record<string, string>>,
): Promise<void> {
  const lambdaServices = services.filter(
    (s) => !existsSync(`${resolveServiceDir(root, s)}/Dockerfile`),
  );

  if (lambdaServices.length === 0) return;

  console.log(`\n── Deploying ${lambdaServices.length} Lambda service(s) ──`);

  await Promise.all(
    lambdaServices.map((service) =>
      deployCommand({
        service,
        stage,
        envName,
        sha: artifactVars[service]?.sha,
      }),
    ),
  );
}
