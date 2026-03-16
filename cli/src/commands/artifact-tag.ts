/**
 * ascli artifact:tag <service> --sha <sha> --tag <tag> --stage <stage>
 *
 * Tags an artifact with a lifecycle stage (dev, staging, staging_rejected, prod).
 * Atomically writes TAG + ARTIFACT records in DynamoDB.
 * Updates S3 object tag to match.
 * For staging tags: records a verification snapshot with alongside services.
 */

import { detectDeployer } from "../lib/shell.js";
import {
  discoverRoot,
  discoverComponents,
  resolveArtifactBucket,
  resolveArtifactKey,
  resolveDeploymentsTable,
  resolveEnvName,
  resolveProfile,
  resolveRegion,
  resolveSystem,
} from "../lib/conventions.js";
import { Manifest } from "../lib/manifest.js";
import { setArtifactS3Tags, type ArtifactS3Tags } from "../lib/s3-tags.js";

export type ArtifactTagOptions = {
  service: string;
  sha: string;
  tag: string;
  stage: string;
  reason?: string;
};

const VALID_TAGS = ["dev", "staging", "staging_rejected", "prod"] as const;

export async function artifactTagCommand(opts: ArtifactTagOptions): Promise<void> {
  if (!VALID_TAGS.includes(opts.tag as (typeof VALID_TAGS)[number])) {
    throw new Error(`Invalid tag "${opts.tag}". Valid tags: ${VALID_TAGS.join(", ")}`);
  }

  if (opts.tag === "staging_rejected" && !opts.reason) {
    throw new Error("--reason is required when tagging as staging_rejected");
  }

  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.stage);
  const profile = resolveProfile(root, opts.stage);
  const tableName = resolveDeploymentsTable(root, opts.stage);
  const system = resolveSystem(root);
  const manifest = new Manifest(tableName, region, system, profile);
  const taggedBy = detectDeployer();

  console.log(`Tagging ${opts.service}@${opts.sha} → ${opts.tag}`);

  await manifest.tagArtifact(opts.service, opts.tag, opts.sha, taggedBy, opts.reason);

  // Update S3 object tag (zip artifacts only)
  try {
    const bucket = resolveArtifactBucket(root, opts.stage);
    const key = resolveArtifactKey(opts.service, opts.sha, "zip");
    const s3Status = opts.tag === "staging_rejected" ? "rejected" : opts.tag;
    await setArtifactS3Tags(
      bucket,
      key,
      { status: s3Status as ArtifactS3Tags["status"] },
      region,
      profile,
    );
  } catch {
    console.log("(S3 tag update skipped — artifact may be ECR-based)");
  }

  // For staging: record verification snapshot
  if (opts.tag === "staging") {
    const envName = resolveEnvName(opts.stage, undefined);
    const services = discoverComponents(root);
    const otherTags = await manifest.getAllServiceTags("staging", services);
    const alongside: Record<string, string> = {};
    for (const t of otherTags) {
      if (t.service !== opts.service) alongside[t.service] = t.sha;
    }

    await manifest.recordVerification(opts.stage, envName, {
      service: opts.service,
      sha: opts.sha,
      alongside,
      e2eResult: "passed",
      pipelineRun: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
      recordedAt: new Date().toISOString(),
    });

    console.log(`Verification snapshot recorded (alongside: ${Object.keys(alongside).join(", ") || "none"})`);
  }

  if (opts.tag === "staging_rejected") {
    const envName = resolveEnvName(opts.stage, undefined);
    const services = discoverComponents(root);
    const otherTags = await manifest.getAllServiceTags("staging", services);
    const alongside: Record<string, string> = {};
    for (const t of otherTags) {
      if (t.service !== opts.service) alongside[t.service] = t.sha;
    }

    await manifest.recordVerification(opts.stage, envName, {
      service: opts.service,
      sha: opts.sha,
      alongside,
      e2eResult: "failed",
      pipelineRun: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
      recordedAt: new Date().toISOString(),
    });
  }

  console.log(`Tagged: ${opts.service}@${opts.sha} → ${opts.tag}`);
}
