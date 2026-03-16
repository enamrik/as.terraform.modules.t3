/**
 * ascli env:apply|env:destroy|env:status|env:history|env:list
 *
 * System layer lifecycle management.
 * - apply: terraform apply on system layer (idempotent)
 * - destroy: terraform destroy on system layer + manifest cleanup
 * - status: show current deployment manifest
 * - history: show deployment history
 * - list: show all environments for this system in a stage
 */

import {
  discoverRoot,
  resolveDeploymentsTable,
  resolveProfile,
  resolveRegion,
  resolveSystem,
} from "../lib/conventions.js";
import { terraformRun } from "../lib/terraform.js";
import { Manifest } from "../lib/manifest.js";

export type EnvApplyOptions = {
  stage: string;
  envName: string;
  autoApprove?: boolean;
};

export type EnvDestroyOptions = {
  stage: string;
  envName: string;
  autoApprove?: boolean;
};

export type EnvStatusOptions = {
  stage: string;
  envName: string;
};

export type EnvListOptions = {
  stage: string;
};

function createManifest(root: string, stage: string): Manifest {
  const region = resolveRegion(root, stage);
  const tableName = resolveDeploymentsTable(root, stage);
  const system = resolveSystem(root);
  const profile = resolveProfile(root, stage);
  return new Manifest(tableName, region, system, profile);
}

export function envApplyCommand(opts: EnvApplyOptions): void {
  const root = discoverRoot(process.cwd());

  console.log(`Applying system layer: ${opts.stage}/${opts.envName}`);
  terraformRun("apply", {
    root,
    stage: opts.stage,
    envName: opts.envName,
    type: "system",
    autoApprove: opts.autoApprove,
  });
}

export async function envDestroyCommand(opts: EnvDestroyOptions): Promise<void> {
  const root = discoverRoot(process.cwd());

  console.log(`Destroying system layer: ${opts.stage}/${opts.envName}`);
  terraformRun("destroy", {
    root,
    stage: opts.stage,
    envName: opts.envName,
    type: "system",
    vars: { sha: "destroying" },
    autoApprove: opts.autoApprove,
  });

  console.log("\nCleaning up deployment manifest...");
  const manifest = createManifest(root, opts.stage);
  await manifest.deleteEnvironment(opts.stage, opts.envName);

  console.log(`\nEnvironment ${opts.stage}/${opts.envName} destroyed.`);
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
  const manifest = createManifest(root, opts.stage);

  const components = await manifest.listComponents(opts.stage, opts.envName);

  if (components.length === 0) {
    console.log(`No components deployed in ${opts.stage}/${opts.envName}`);
    return;
  }

  console.log(`\nEnvironment: ${opts.stage}/${opts.envName}`);
  console.log("─".repeat(60));

  for (const c of components) {
    console.log(`  ${c.service.padEnd(25)} ${c.artifactSha.padEnd(12)} ${c.deployedAt}`);
  }
}

export async function envHistoryCommand(
  opts: EnvStatusOptions & { service?: string },
): Promise<void> {
  const root = discoverRoot(process.cwd());
  const manifest = createManifest(root, opts.stage);

  const history = await manifest.getHistory(opts.stage, opts.envName, opts.service);

  if (history.length === 0) {
    console.log(`No deployment history for ${opts.stage}/${opts.envName}`);
    return;
  }

  console.log(`\nDeployment history: ${opts.stage}/${opts.envName}`);
  console.log("─".repeat(70));

  for (const h of history) {
    console.log(
      `  ${h.deployedAt}  ${h.service.padEnd(25)} ${h.artifactSha.padEnd(12)} ${h.status}`,
    );
  }
}
