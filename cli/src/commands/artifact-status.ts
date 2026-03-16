/**
 * ascli artifact:status <service> --stage <stage> [--sha <sha>]
 *
 * Shows artifact lifecycle status.
 * Without --sha: shows latest SHA per tag (dev, staging, prod).
 * With --sha: shows full lifecycle for a specific artifact.
 */

import {
  discoverRoot,
  resolveDeploymentsTable,
  resolveProfile,
  resolveRegion,
  resolveSystem,
} from "../lib/conventions.js";
import { Manifest } from "../lib/manifest.js";

export type ArtifactStatusOptions = {
  service: string;
  stage: string;
  sha?: string;
};

export async function artifactStatusCommand(opts: ArtifactStatusOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.stage);
  const profile = resolveProfile(root, opts.stage);
  const tableName = resolveDeploymentsTable(root, opts.stage);
  const system = resolveSystem(root);
  const manifest = new Manifest(tableName, region, system, profile);

  if (opts.sha) {
    const meta = await manifest.getArtifactMeta(opts.service, opts.sha);
    if (!meta) {
      console.log(`No artifact record for ${opts.service}@${opts.sha}`);
      return;
    }

    console.log(`\n${opts.service}@${opts.sha}`);
    console.log("─".repeat(50));
    console.log(`  Status:   ${meta.status}`);
    console.log(`  Built:    ${meta.builtAt} by ${meta.builtBy}`);
    if (meta.testedIn) console.log(`  Tested:   ${meta.testedIn}`);
    if (meta.rejectedReason) console.log(`  Rejected: ${meta.rejectedReason}`);
    return;
  }

  const tags = await manifest.getAllTags(opts.service);

  if (tags.length === 0) {
    console.log(`No tags for ${opts.service}`);
    return;
  }

  console.log(`\n${opts.service}`);
  console.log("─".repeat(50));

  for (const tag of tags) {
    console.log(`  ${tag.tag.padEnd(20)} ${tag.sha.padEnd(12)} ${tag.taggedAt}`);
  }
}
