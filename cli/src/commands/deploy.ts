/**
 * as deploy <service> --stage <stage> --env <env> --sha <sha>
 * as rollback <service> --stage <stage> --env <env>
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
import { execSync } from "node:child_process";
import { gitShortSha } from "../lib/shell.js";
import {
  discoverRoot,
  resolveArtifactBucket,
  resolveArtifactKey,
  resolveDeploymentsTable,
  resolveProfile,
  resolveRegion,
  resolveServiceDir,
  resolveSystem,
} from "../lib/conventions.js";
import { Manifest } from "../lib/manifest.js";

export type DeployOptions = {
  service: string;
  stage: string;
  envName: string;
  sha?: string;
  autoApprove?: boolean;
};

export type RollbackOptions = {
  service: string;
  stage: string;
  envName: string;
  autoApprove?: boolean;
};

export async function deployCommand(opts: DeployOptions): Promise<void> {
  const root = discoverRoot(process.cwd());
  const region = resolveRegion(root, opts.stage);
  const profile = resolveProfile(root, opts.stage);
  const sha = opts.sha ?? gitShortSha(root);
  const serviceDir = resolveServiceDir(root, opts.service);
  const isImage = existsSync(`${serviceDir}/Dockerfile`);

  if (isImage) {
    console.error("CodeDeploy deploy is only supported for Lambda (zip) services.");
    process.exit(1);
  }

  const bucket = resolveArtifactBucket(root, opts.stage);
  const artifactKey = resolveArtifactKey(opts.service, sha, "zip");
  const functionName = `${opts.stage}-${opts.envName}-${opts.service}`;
  const codedeployApp = functionName;
  const deploymentGroup = functionName;

  console.log(`Deploying ${opts.service} → ${opts.stage}/${opts.envName} @ ${sha}`);
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
  const tableName = resolveDeploymentsTable(root, opts.stage);
  const system = resolveSystem(root);
  const manifest = new Manifest(tableName, region, system, profile);
  const deployedBy = detectDeployer();
  const current = await manifest.getComponent(opts.stage, opts.envName, opts.service);
  const artifactUri = `s3://${bucket}/${artifactKey}`;

  try {
    await manifest.deploy(
      opts.stage,
      opts.envName,
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
  const tableName = resolveDeploymentsTable(root, opts.stage);
  const rollbackSystem = resolveSystem(root);
  const manifest = new Manifest(tableName, region, rollbackSystem, profile);

  const current = await manifest.getComponent(opts.stage, opts.envName, opts.service);
  if (!current) {
    console.error(`No deployment found for ${opts.service} in ${opts.stage}/${opts.envName}`);
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
    envName: opts.envName,
    sha: current.previousSha,
  });

  console.log(`\nRollback complete: ${opts.service}@${current.previousSha}`);
}

function detectDeployer(): string {
  if (process.env.GITHUB_ACTIONS) {
    return `github-actions/${process.env.GITHUB_RUN_ID ?? "unknown"}`;
  }
  try {
    const user = execSync("whoami", { encoding: "utf-8" }).trim();
    return `local/${user}`;
  } catch {
    return "local/unknown";
  }
}
