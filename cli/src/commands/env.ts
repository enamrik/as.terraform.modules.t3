/**
 * ascli env:apply|env:destroy|env:status|env:history|env:list|env:sync
 *
 * System layer lifecycle management.
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
import type { IacEngine } from "../lib/engine.js";
import { Manifest } from "../lib/manifest.js";
import { deployCommand } from "./deploy.js";

export type EnvApplyOptions = {
  stage: string;
  envName?: string;
  autoApprove?: boolean;
};

export type EnvDestroyOptions = {
  stage: string;
  envName?: string;
  autoApprove?: boolean;
};

export type EnvStatusOptions = {
  stage: string;
  envName?: string;
};

export type EnvListOptions = {
  stage: string;
};

export type EnvSyncOptions = {
  stage: string;
  envName?: string;
};

function createManifest(root: string, stage: string): Manifest {
  const region = resolveRegion(root, stage);
  const tableName = resolveDeploymentsTable(root, stage);
  const system = resolveSystem(root);
  const profile = resolveProfile(root, stage);
  return new Manifest(tableName, region, system, profile);
}

export function envApplyCommand(opts: EnvApplyOptions, engine: IacEngine): void {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);

  console.log(`Applying env layer: ${opts.stage}/${envName}`);
  engine.apply({
    root,
    stage: opts.stage,
    envName,
    type: "env",
    autoApprove: opts.autoApprove,
  });
}

export async function envDestroyCommand(opts: EnvDestroyOptions, engine: IacEngine): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);

  console.log(`Destroying env layer: ${opts.stage}/${envName}`);
  engine.destroy({
    root,
    stage: opts.stage,
    envName,
    type: "env",
    vars: { sha: "destroying" },
    autoApprove: opts.autoApprove,
  });

  console.log("\nCleaning up deployment manifest...");
  const manifest = createManifest(root, opts.stage);
  await manifest.deleteEnvironment(opts.stage, envName);

  console.log(`\nEnvironment ${opts.stage}/${envName} destroyed.`);
}

export async function envListCommand(opts: EnvListOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const system = resolveSystem(root);
  const manifest = createManifest(root, opts.stage);

  const envs = await manifest.listEnvironments(opts.stage);

  if (envs.length === 0) {
    console.log(`No environments for ${system} in ${opts.stage}`);
    return;
  }

  console.log(`\nEnvironments: ${system} / ${opts.stage}`);
  console.log("─".repeat(60));

  for (const e of envs) {
    console.log(
      `  ${e.envName.padEnd(25)} ${String(e.componentCount).padEnd(6)} components  ${e.lastDeployedAt}`,
    );
  }
}

export async function envStatusCommand(opts: EnvStatusOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);
  const manifest = createManifest(root, opts.stage);

  const components = await manifest.listComponents(opts.stage, envName);

  if (components.length === 0) {
    console.log(`No components deployed in ${opts.stage}/${envName}`);
    return;
  }

  console.log(`\nEnvironment: ${opts.stage}/${envName}`);
  console.log("─".repeat(60));

  for (const c of components) {
    console.log(`  ${c.service.padEnd(25)} ${c.artifactSha.padEnd(12)} ${c.deployedAt}`);
  }
}

export async function envHistoryCommand(
  opts: EnvStatusOptions & { service?: string },
): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);
  const manifest = createManifest(root, opts.stage);

  const history = await manifest.getHistory(opts.stage, envName, opts.service);

  if (history.length === 0) {
    console.log(`No deployment history for ${opts.stage}/${envName}`);
    return;
  }

  console.log(`\nDeployment history: ${opts.stage}/${envName}`);
  console.log("─".repeat(70));

  for (const h of history) {
    console.log(
      `  ${h.deployedAt}  ${h.service.padEnd(25)} ${h.artifactSha.padEnd(12)} ${h.status}`,
    );
  }
}

export async function envSyncCommand(opts: EnvSyncOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const envName = resolveEnvName(opts.stage, opts.envName);
  const manifest = createManifest(root, opts.stage);

  const services = discoverComponents(root);
  const sourceTag = opts.stage;
  const tags = await manifest.getAllServiceTags(sourceTag, services);

  if (tags.length === 0) {
    console.log(`No "${sourceTag}"-tagged artifacts found. Nothing to sync.`);
    return;
  }

  console.log(`Syncing ${opts.stage}/${envName} to "${sourceTag}" baseline (${tags.length} service(s))\n`);

  for (const tag of tags) {
    console.log(`  ${tag.service}@${tag.sha}`);
    await deployCommand({
      service: tag.service,
      stage: opts.stage,
      envName,
      sha: tag.sha,
    });
  }

  console.log(`\nSync complete: ${opts.stage}/${envName}`);
}
