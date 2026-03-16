/**
 * as publish <service> --stage <stage>
 *
 * Uploads a built artifact to S3 (Zip) or ECR (Image).
 * Returns the artifact URI that terraform consumes.
 */

import { existsSync } from "node:fs";
import { exec, gitShortSha } from "../lib/shell.js";
import {
  resolveArtifactBucket,
  resolveArtifactKey,
  resolveEcrRepo,
  resolveServiceDir,
  resolveProfile,
  resolveRegion,
  discoverRoot,
} from "../lib/conventions.js";

export type PublishOptions = {
  service: string;
  stage: string;
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

function publishZip(
  root: string,
  serviceDir: string,
  service: string,
  stage: string,
  sha: string,
): PublishResult {
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

export function publishCommand(opts: PublishOptions): PublishResult {
  const root = discoverRoot(process.cwd());
  const serviceDir = resolveServiceDir(root, opts.service);
  const sha = gitShortSha(root);
  const buildType = detectBuildType(serviceDir);

  console.log(`Publishing ${opts.service} (${buildType}) → ${opts.stage}`);

  if (buildType === "zip") {
    return publishZip(root, serviceDir, opts.service, opts.stage, sha);
  }

  return publishImage(root, opts.service, opts.stage, sha);
}
