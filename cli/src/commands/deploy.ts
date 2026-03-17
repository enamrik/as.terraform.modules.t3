/**
 * ascli deploy <service> --stage <stage> --env <env> --sha <sha>
 * ascli rollback <service> --stage <stage> --env <env> [--to <sha>]
 *
 * Deploy: fast code-only update via CodeDeploy (no terraform).
 *
 * Lambda path:
 *   1. UpdateFunctionCode → new S3 artifact on $LATEST
 *   2. PublishVersion → immutable version number
 *   3. CreateDeployment → CodeDeploy shifts the "live" alias
 *   4. Update deployment manifest in DynamoDB
 *
 * ECS path:
 *   1. Describe current task definition
 *   2. Register new task definition revision with updated image
 *   3. CreateDeployment → CodeDeploy blue/green with new task def
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
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  CodeDeployClient,
  CreateDeploymentCommand,
} from "@aws-sdk/client-codedeploy";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
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
  imageUri?: string;
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

  const credentials = fromSSO({ profile });

  if (isImage) {
    await deployEcs(opts, root, region, envName, sha, manifest, credentials);
  } else {
    await deployLambda(opts, root, region, envName, sha, manifest, credentials);
  }
}

async function deployLambda(
  opts: DeployOptions,
  root: string,
  region: string,
  envName: string,
  sha: string,
  manifest: Manifest,
  credentials: ReturnType<typeof fromSSO>,
): Promise<void> {
  const bucket = resolveArtifactBucket(root, opts.stage);
  const artifactKey = resolveArtifactKey(opts.service, sha, "zip");
  const functionName = `${opts.stage}-${envName}-${opts.service}`;
  const codedeployApp = functionName;
  const deploymentGroup = functionName;

  console.log(`Deploying ${opts.service} → ${opts.stage}/${envName} @ ${sha}`);
  console.log(`Function: ${functionName}`);
  console.log(`Artifact: s3://${bucket}/${artifactKey}`);

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
  await updateManifest(manifest, opts, envName, sha, `s3://${bucket}/${artifactKey}`);

  console.log(`\nDeploy complete: ${opts.service}@${sha} (deployment: ${deployment.deploymentId})`);
}

async function deployEcs(
  opts: DeployOptions,
  root: string,
  region: string,
  envName: string,
  sha: string,
  manifest: Manifest,
  credentials: ReturnType<typeof fromSSO>,
): Promise<void> {
  const serviceName = `${opts.stage}-${envName}-${opts.service}`;
  const codedeployApp = serviceName;
  const deploymentGroup = serviceName;

  console.log(`Deploying ${opts.service} → ${opts.stage}/${envName} @ ${sha} (ECS)`);

  const ecs = new ECSClient({ region, credentials });
  const codedeploy = new CodeDeployClient({ region, credentials });

  // 1. Get the current ECS service to find its task definition and cluster
  const sts = new STSClient({ region, credentials });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const ecsClusterArn = `arn:aws:ecs:${region}:${identity.Account}:cluster/${opts.stage}-${envName}`;

  const svcDescription = await ecs.send(
    new DescribeServicesCommand({
      cluster: ecsClusterArn,
      services: [serviceName],
    }),
  );

  const ecsService = svcDescription.services?.[0];
  if (!ecsService) {
    throw new Error(`ECS service ${serviceName} not found in cluster ${ecsClusterArn}`);
  }

  const currentTaskDefArn = ecsService.taskDefinition!;
  console.log(`Current task definition: ${currentTaskDefArn}`);

  // 2. Describe current task definition to clone it
  const taskDefResp = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: currentTaskDefArn }),
  );
  const taskDef = taskDefResp.taskDefinition!;

  // 3. Build new image URI
  const imageUri = opts.imageUri;
  if (!imageUri) {
    throw new Error("ECS deploy requires --image-uri or an imageUri from the artifact step.");
  }

  // 4. Register new task definition with updated image
  const containerDefs = taskDef.containerDefinitions!.map((c) => ({
    ...c,
    image: c.name === opts.service ? imageUri : c.image,
  }));

  console.log(`Registering new task definition with image: ${imageUri}`);
  const newTaskDef = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: taskDef.family!,
      taskRoleArn: taskDef.taskRoleArn,
      executionRoleArn: taskDef.executionRoleArn,
      networkMode: taskDef.networkMode,
      containerDefinitions: containerDefs,
      requiresCompatibilities: taskDef.requiresCompatibilities,
      cpu: taskDef.cpu,
      memory: taskDef.memory,
      runtimePlatform: taskDef.runtimePlatform,
    }),
  );
  const newTaskDefArn = newTaskDef.taskDefinition!.taskDefinitionArn!;
  console.log(`New task definition: ${newTaskDefArn}`);

  // 5. Get container name and port for AppSpec
  const container = taskDef.containerDefinitions![0]!;
  const containerName = container.name!;
  const containerPort = container.portMappings?.[0]?.containerPort ?? 8080;

  // 6. Create CodeDeploy deployment with ECS AppSpec
  console.log("Creating CodeDeploy deployment...");
  const appSpec = {
    version: 0.0,
    Resources: [
      {
        TargetService: {
          Type: "AWS::ECS::Service",
          Properties: {
            TaskDefinition: newTaskDefArn,
            LoadBalancerInfo: {
              ContainerName: containerName,
              ContainerPort: containerPort,
            },
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

  // 7. Update manifest
  await updateManifest(manifest, opts, envName, sha, imageUri);

  console.log(`\nDeploy complete: ${opts.service}@${sha} (deployment: ${deployment.deploymentId})`);
}

async function updateManifest(
  manifest: Manifest,
  opts: DeployOptions,
  envName: string,
  sha: string,
  artifactUri: string,
): Promise<void> {
  const deployedBy = detectDeployer();
  const current = await manifest.getComponent(opts.stage, envName, opts.service);

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
