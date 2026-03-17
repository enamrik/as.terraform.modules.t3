/**
 * ascli promote --to <stage> [--service <svc>] [--force]
 *
 * Promotes staging-tagged artifacts to a target stage.
 * Runs env:apply once, then for each service: component:apply → deploy.
 */

import { detectDeployer } from "../lib/shell.js";
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
import { Manifest } from "../lib/manifest.js";
import { deployCommand } from "./deploy.js";
import { envApplyCommand } from "./env.js";
import { componentApplyCommand } from "./component.js";

export type PromoteOptions = {
  to: string;
  service?: string;
  force?: boolean;
};

export async function promoteCommand(opts: PromoteOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.to);
  const profile = resolveProfile(root, opts.to);
  const tableName = resolveDeploymentsTable(root, opts.to);
  const system = resolveSystem(root);
  const manifest = new Manifest(tableName, region, system, profile);
  const taggedBy = detectDeployer();

  const services = opts.service
    ? [opts.service]
    : discoverComponents(root);

  // Read staging-tagged artifacts from the staging stage's table
  const stagingRegion = resolveRegion(root, "staging");
  const stagingProfile = resolveProfile(root, "staging");
  const stagingTable = resolveDeploymentsTable(root, "staging");
  const stagingManifest = new Manifest(stagingTable, stagingRegion, system, stagingProfile);

  const tags = await stagingManifest.getAllServiceTags("staging", services);

  if (tags.length === 0) {
    console.error("No staging-tagged artifacts found.");
    process.exit(1);
  }

  const targetEnv = resolveEnvName(opts.to, undefined);
  const engine = resolveEngine();

  console.log(`Promoting ${tags.length} service(s) → ${opts.to}/${targetEnv}\n`);

  // Apply shared environment infrastructure once before deploying services
  envApplyCommand({ stage: opts.to, envName: targetEnv, autoApprove: true }, engine);

  for (const tag of tags) {
    // Check for rejected artifacts
    if (!opts.force) {
      const meta = await stagingManifest.getArtifactMeta(tag.service, tag.sha);
      if (meta?.status === "staging_rejected") {
        throw new Error(
          `${tag.service}@${tag.sha} is rejected: ${meta.rejectedReason ?? "unknown"}. Use --force to override.`,
        );
      }
    }

    console.log(`  ${tag.service}@${tag.sha}`);

    // Apply component infrastructure before deploying
    componentApplyCommand(
      {
        stage: opts.to,
        envName: targetEnv,
        sha: tag.sha,
        component: tag.service,
        autoApprove: true,
      },
      engine,
    );

    await deployCommand({
      service: tag.service,
      stage: opts.to,
      envName: targetEnv,
      sha: tag.sha,
      force: opts.force,
    });

    await manifest.tagArtifact(tag.service, opts.to, tag.sha, taggedBy);
  }

  console.log(`\nPromotion complete: ${tags.length} service(s) → ${opts.to}`);
}
