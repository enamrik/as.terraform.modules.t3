/**
 * ascli promote --to <stage> [--service <svc>] [--force]
 *
 * Promotes staging-tagged artifacts to a target stage.
 * Reads TAG records for "staging", deploys each to the target, updates TAG for target.
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
import { Manifest } from "../lib/manifest.js";
import { deployCommand } from "./deploy.js";

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
  console.log(`Promoting ${tags.length} service(s) → ${opts.to}/${targetEnv}\n`);

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
