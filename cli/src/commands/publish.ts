/**
 * ascli publish <service> --stage <stage>
 *
 * Uploads a built artifact to S3 (Zip) or ECR (Image).
 * Returns the artifact URI that terraform consumes.
 * Tags S3 artifacts with status=dev on upload.
 */

import { existsSync } from "node:fs";
import { exec, resolveArtifactSha, detectDeployer } from "../lib/shell.js";
import {
  resolveArtifactBucket,
  resolveArtifactKey,
  resolveEcrRepo,
  resolveServiceDir,
  resolveProfile,
  resolveRegion,
  discoverRoot,
} from "../lib/conventions.js";
import { setArtifactS3Tags } from "../lib/s3-tags.js";

export type PublishOptions = {
  service: string;
  stage: string;
  sha?: string;
  dirty?: boolean;
};

export type PublishResult = {
  service: string;
  artifactUri: string;
  artifactSha: string;
  type: "s3" | "ecr";
};

function detectBuildType(serviceDir: string): "zip" | "image" {
  if (existsSync(`${serviceDir}/Dockerfile`)) return "image";
  return "zip";
}

async function publishZip(
  root: string,
  serviceDir: string,
  service: string,
  stage: string,
  sha: string,
): Promise<PublishResult> {
  const bucket = resolveArtifactBucket(root, stage);
  const key = resolveArtifactKey(service, sha, "zip");
  const region = resolveRegion(root, stage);
  const profile = resolveProfile(root, stage);
  const distDir = `${serviceDir}/dist`;

  console.log("Creating zip archive...");
  exec(`rm -f /tmp/${service}-${sha}.zip`);
  exec(`cd ${distDir} && zip -r /tmp/${service}-${sha}.zip .`);

  console.log(`Uploading to s3://${bucket}/${key}`);
  exec(
    `aws s3 cp /tmp/${service}-${sha}.zip s3://${bucket}/${key} --region ${region} --profile ${profile}`,
  );

  await setArtifactS3Tags(bucket, key, { status: "dev", builtBy: detectDeployer() }, region, profile);

  return {
    service,
    artifactUri: `s3://${bucket}/${key}`,
    artifactSha: sha,
    type: "s3",
  };
}

function publishImage(
  root: string,
  service: string,
  stage: string,
  sha: string,
): PublishResult {
  const region = resolveRegion(root, stage);
  const profile = resolveProfile(root, stage);
  const repoName = resolveEcrRepo(root, service);
  const accountId = exec(
    `aws sts get-caller-identity --query Account --output text --profile ${profile}`,
    { silent: true },
  ).trim();
  const registryUri = `${accountId}.dkr.ecr.${region}.amazonaws.com`;
  const repoUri = `${registryUri}/${repoName}`;

  console.log("Logging in to ECR...");
  exec(
    `aws ecr get-login-password --region ${region} --profile ${profile} | docker login --username AWS --password-stdin ${registryUri}`,
  );

  const localTag = `${service}:${sha}`;
  console.log(`Pushing ${localTag} → ${repoUri}:${sha}`);
  exec(`docker tag ${localTag} ${repoUri}:${sha}`);
  exec(`docker push ${repoUri}:${sha}`);

  return {
    service,
    artifactUri: `${repoUri}:${sha}`,
    artifactSha: sha,
    type: "ecr",
  };
}

export async function publishCommand(opts: PublishOptions): Promise<PublishResult> {
  const root = discoverRoot(process.cwd());
  const serviceDir = resolveServiceDir(root, opts.service);
  const sha = opts.sha ?? resolveArtifactSha(root, `${serviceDir}/dist`, opts.dirty ?? false);
  const buildType = detectBuildType(serviceDir);

  console.log(`Publishing ${opts.service} (${buildType}) → ${opts.stage}`);

  if (buildType === "zip") {
    return publishZip(root, serviceDir, opts.service, opts.stage, sha);
  }

  return publishImage(root, opts.service, opts.stage, sha);
}
