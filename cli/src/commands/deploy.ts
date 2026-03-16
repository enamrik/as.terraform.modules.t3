/**
 * ascli deploy <service> --stage <stage> --env <env> --sha <sha>
 * ascli rollback <service> --stage <stage> --env <env> [--to <sha>]
 *
 * Deploy: fast code-only update via CodeDeploy (no terraform).
 *   1. UpdateFunctionCode → new S3 artifact on $LATEST
 *   2. PublishVersion → immutable version number
 *   3. CreateDeployment → CodeDeploy shifts the "live" alias
 *   4. Update deployment manifest in DynamoDB
 *
 * Rollback: reads the previous SHA from the manifest and redeploys it.
 */

import {
  LambdaClient,
  UpdateFunctionCodeCommand,
  PublishVersionCommand,
  GetAliasCommand,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  CodeDeployClient,
  CreateDeploymentCommand,
} from "@aws-sdk/client-codedeploy";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { existsSync } from "node:fs";
import { gitShortSha, detectDeployer } from "../lib/shell.js";
import {
  discoverRoot,
  resolveArtifactBucket,
  resolveArtifactKey,
  resolveDeploymentsTable,
  resolveEnvName,
  resolveProfile,
  resolveRegion,
  resolveServiceDir,
  resolveSystem,
} from "../lib/conventions.js";
import { Manifest } from "../lib/manifest.js";

export type DeployOptions = {
  service: string;
  stage: string;
  envName?: string;
  sha?: string;
  force?: boolean;
};

export type RollbackOptions = {
  service: string;
  stage: string;
  envName?: string;
  toSha?: string;
};

export async function deployCommand(opts: DeployOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.stage);
  const profile = resolveProfile(root, opts.stage);
  const envName = resolveEnvName(opts.stage, opts.envName);
  const sha = opts.sha ?? gitShortSha(root);
  const serviceDir = resolveServiceDir(root, opts.service);
  const isImage = existsSync(`${serviceDir}/Dockerfile`);

  if (isImage) {
    console.error("CodeDeploy deploy is only supported for Lambda (zip) services.");
    process.exit(1);
  }

  const bucket = resolveArtifactBucket(root, opts.stage);
  const artifactKey = resolveArtifactKey(opts.service, sha, "zip");
  const functionName = `${opts.stage}-${envName}-${opts.service}`;
  const codedeployApp = functionName;
  const deploymentGroup = functionName;

  const tableName = resolveDeploymentsTable(root, opts.stage);
  const system = resolveSystem(root);
  const manifest = new Manifest(tableName, region, system, profile);

  // Deploy guard: refuse rejected artifacts for non-dev stages
  if (!opts.force && opts.stage !== "dev") {
    const meta = await manifest.getArtifactMeta(opts.service, sha);
    if (meta?.status === "staging_rejected") {
      throw new Error(
        `Artifact ${opts.service}@${sha} is rejected: ${meta.rejectedReason ?? "unknown reason"}. Use --force to override.`,
      );
    }
  }

  console.log(`Deploying ${opts.service} → ${opts.stage}/${envName} @ ${sha}`);
  console.log(`Function: ${functionName}`);
  console.log(`Artifact: s3://${bucket}/${artifactKey}`);

  const credentials = fromSSO({ profile });
  const lambda = new LambdaClient({ region, credentials });
  const codedeploy = new CodeDeployClient({ region, credentials });

  // 1. Get current alias version (needed for CodeDeploy AppSpec)
  const alias = await lambda.send(
    new GetAliasCommand({ FunctionName: functionName, Name: "live" }),
  );
  const currentVersion = alias.FunctionVersion!;
  console.log(`\nCurrent version: ${currentVersion}`);

  // 2. Update function code
  console.log("Updating function code...");
  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      S3Bucket: bucket,
      S3Key: artifactKey,
    }),
  );

  // 3. Wait for update to complete
  console.log("Waiting for function update...");
  await waitUntilFunctionUpdatedV2(
    { client: lambda, maxWaitTime: 120 },
    { FunctionName: functionName },
  );

  // 4. Publish version
  console.log("Publishing new version...");
  const published = await lambda.send(
    new PublishVersionCommand({
      FunctionName: functionName,
      Description: `Deploy ${sha}`,
    }),
  );
  const targetVersion = published.Version!;
  console.log(`Published version: ${targetVersion}`);

  // 5. Create CodeDeploy deployment
  console.log("Creating CodeDeploy deployment...");
  const appSpec = {
    version: 0.0,
    Resources: [
      {
        myLambdaFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Name: functionName,
            Alias: "live",
            CurrentVersion: currentVersion,
            TargetVersion: targetVersion,
          },
        },
      },
    ],
  };

  const deployment = await codedeploy.send(
    new CreateDeploymentCommand({
      applicationName: codedeployApp,
      deploymentGroupName: deploymentGroup,
      revision: {
        revisionType: "AppSpecContent",
        appSpecContent: {
          content: JSON.stringify(appSpec),
        },
      },
    }),
  );
  console.log(`Deployment started: ${deployment.deploymentId}`);

  // 6. Update manifest
  const deployedBy = detectDeployer();
  const current = await manifest.getComponent(opts.stage, envName, opts.service);
  const artifactUri = `s3://${bucket}/${artifactKey}`;

  try {
    await manifest.deploy(
      opts.stage,
      envName,
      opts.service,
      sha,
      artifactUri,
      deployedBy,
      current?.version ?? null,
    );
    console.log(`\nManifest updated: ${opts.service}@${sha}`);
  } catch (err) {
    console.error("\nWarning: Failed to update deployment manifest:", err);
    console.error("Deployment was created but manifest is out of sync.");
  }

  console.log(`\nDeploy complete: ${opts.service}@${sha} (deployment: ${deployment.deploymentId})`);
}

export async function rollbackCommand(opts: RollbackOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.stage);
  const profile = resolveProfile(root, opts.stage);
  const envName = resolveEnvName(opts.stage, opts.envName);
  const tableName = resolveDeploymentsTable(root, opts.stage);
  const rollbackSystem = resolveSystem(root);
  const manifest = new Manifest(tableName, region, rollbackSystem, profile);

  if (opts.toSha) {
    console.log(`Rolling back ${opts.service} → ${opts.toSha}`);
    await deployCommand({
      service: opts.service,
      stage: opts.stage,
      envName,
      sha: opts.toSha,
    });
    console.log(`\nRollback complete: ${opts.service}@${opts.toSha}`);
    return;
  }

  const current = await manifest.getComponent(opts.stage, envName, opts.service);
  if (!current) {
    console.error(`No deployment found for ${opts.service} in ${opts.stage}/${envName}`);
    process.exit(1);
  }

  if (!current.previousSha) {
    console.error(`No previous version to rollback to for ${opts.service}`);
    process.exit(1);
  }

  console.log(`Rolling back ${opts.service}: ${current.artifactSha} → ${current.previousSha}`);

  await deployCommand({
    service: opts.service,
    stage: opts.stage,
    envName,
    sha: current.previousSha,
  });

  console.log(`\nRollback complete: ${opts.service}@${current.previousSha}`);
}
