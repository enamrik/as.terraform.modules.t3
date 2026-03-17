/**
 * AsService — unified service module that deploys to Lambda or ECS Fargate.
 *
 * Components declare what they are (a service), not how they run.
 * The runtime config determines infrastructure: Lambda gets a function,
 * alias, and CodeDeploy; ECS gets a task definition, service, and
 * Cloud Map discovery. Wiring is handled by connections — typed edges
 * between resources and the compute target.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {
  type Connection,
  type ServiceTarget,
  LambdaConnectionTarget,
  EcsConnectionTarget,
} from "./connections.js";
import { type Overrides, resolveOverrides } from "./overrides.js";

// ---------------------------------------------------------------------------
// Runtime config — each runtime owns its sizing, strategy, and details
// ---------------------------------------------------------------------------

export interface LambdaConfig {
  packageType?: "Zip" | "Image";
  handler?: pulumi.Input<string>;
  lambdaRuntime?: pulumi.Input<string>;
  deploymentConfig?: pulumi.Input<string>;
  architecture?: "arm64" | "x86_64";
  memory?: pulumi.Input<number>;
  timeout?: pulumi.Input<number>;
  sha?: pulumi.Input<string>;
  imageUri?: pulumi.Input<string>;
}

export interface EcsConfig {
  port?: pulumi.Input<number>;
  healthCheckPath?: pulumi.Input<string>;
  architecture?: "arm64" | "x86_64";
  cpu?: pulumi.Input<number>;
  memory?: pulumi.Input<number>;
  desiredCount?: pulumi.Input<number>;
  imageUri?: pulumi.Input<string>;
}

export type RuntimeConfig =
  | { lambda: LambdaConfig; ecs?: never }
  | { ecs: EcsConfig; lambda?: never };

// ---------------------------------------------------------------------------
// Per-environment overrides
// ---------------------------------------------------------------------------

export interface AsServiceOverrides {
  memory: number;
  timeout: number;
  cpu: number;
  desiredCount: number;
  logRetentionDays: number;
  deploymentConfig: string;
}

const DEFAULT_OVERRIDES: Overrides<AsServiceOverrides> = {
  "prod": {
    logRetentionDays: 90,
    deploymentConfig: "CodeDeployDefault.LambdaLinear10PercentEvery1Minute",
  },
  "staging": {
    logRetentionDays: 30,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
  "dev": {
    logRetentionDays: 14,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
  "pr-*": {
    timeout: 15,
    desiredCount: 1,
    logRetentionDays: 3,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
  "local-*": {
    timeout: 15,
    desiredCount: 1,
    logRetentionDays: 1,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
};

// ---------------------------------------------------------------------------
// Service args
// ---------------------------------------------------------------------------

export interface AsServiceArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;

  // Runtime — omit for default Lambda
  runtime?: RuntimeConfig;

  // Wiring
  connections?: Connection<ServiceTarget>[];
  overrides?: Overrides<AsServiceOverrides>;
  environmentVariables?: pulumi.Input<Record<string, string>>;
  tags?: pulumi.Input<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Shared context passed to runtime strategy functions
// ---------------------------------------------------------------------------

interface RuntimeContext {
  name: string;
  namePrefix: pulumi.Output<string>;
  stage: pulumi.Output<string>;
  envName: pulumi.Output<string>;
  serviceName: pulumi.Output<string>;
  defaultTags: pulumi.Output<Record<string, string>>;
  allEnvVars: pulumi.Output<Record<string, string>>;
  parent: pulumi.Resource;
  vpcId: pulumi.Output<string>;
  privateSubnetIds: pulumi.Output<string[]>;
  overrides: Overrides<AsServiceOverrides> | undefined;
}

interface RuntimeResult {
  roleArn: pulumi.Output<string>;
  roleName: pulumi.Output<string>;
  functionArn: pulumi.Output<string>;
  functionName: pulumi.Output<string>;
  aliasArn: pulumi.Output<string>;
  codedeployAppName: pulumi.Output<string>;
  codedeployDeploymentGroupName: pulumi.Output<string>;
  ecsServiceName: pulumi.Output<string>;
  taskDefinitionArn: pulumi.Output<string>;
}

const empty = pulumi.output("");

// ---------------------------------------------------------------------------
// AsService
// ---------------------------------------------------------------------------

export class AsService extends pulumi.ComponentResource {
  public readonly functionArn: pulumi.Output<string>;
  public readonly functionName: pulumi.Output<string>;
  public readonly aliasArn: pulumi.Output<string>;
  public readonly roleArn: pulumi.Output<string>;
  public readonly roleName: pulumi.Output<string>;
  public readonly codedeployAppName: pulumi.Output<string>;
  public readonly codedeployDeploymentGroupName: pulumi.Output<string>;
  public readonly ecsServiceName: pulumi.Output<string>;
  public readonly taskDefinitionArn: pulumi.Output<string>;
  public readonly serviceUrl: pulumi.Output<string>;

  private readonly resourceName: string;

  constructor(name: string, args: AsServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("as:service:AsService", name, {}, opts);
    this.resourceName = name;

    const stage = pulumi.output(args.stage);
    const envName = pulumi.output(args.envName);
    const serviceName = pulumi.output(args.serviceName);
    const isEcs = args.runtime?.ecs !== undefined;
    const namePrefix = pulumi.interpolate`${stage}-${envName}-${serviceName}`;
    const runtimeLabel = isEcs ? "ecs" : "lambda";

    const defaultTags = pulumi.all([stage, envName, serviceName, pulumi.output(args.tags ?? {})]).apply(([s, e, svc, extra]): Record<string, string> => ({
      environment: s,
      env_name: e,
      service: svc,
      runtime: runtimeLabel,
      project: "as-platform",
      "managed-by": "pulumi",
      ...extra,
    }));

    // Bind connections to a target — accumulates env vars, policies, etc.
    const target = isEcs
      ? new EcsConnectionTarget()
      : new LambdaConnectionTarget();

    for (const connection of args.connections ?? []) {
      connection.bind(target);
    }

    // Merge env vars: connections + explicit environmentVariables
    const connectionEnvVars = target.envVars;
    const allEnvVars = pulumi.all([stage, envName, pulumi.output(args.environmentVariables ?? {})]).apply(([s, e, custom]): Record<string, string> => ({
      STAGE: s,
      ENV_NAME: e,
      ...Object.fromEntries(Object.entries(connectionEnvVars).map(([k, v]) => [k, String(v)])),
      ...custom,
    }));

    // SSM lookups — VPC context (ECS always, Lambda when connections require it)
    const needsVpc = target.needsVpc || isEcs;
    const vpcId = needsVpc
      ? stage.apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/vpc-id` })).apply((p) => p.value)
      : empty;
    const privateSubnetIds = needsVpc
      ? stage.apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/private-subnet-ids` })).apply((p) => JSON.parse(p.value) as string[])
      : pulumi.output([] as string[]);

    const ctx: RuntimeContext = {
      name, namePrefix, stage, envName, serviceName,
      defaultTags, allEnvVars,
      parent: this, vpcId, privateSubnetIds,
      overrides: args.overrides,
    };

    const result = isEcs
      ? createEcsRuntime(ctx, args.runtime!.ecs!, target as EcsConnectionTarget)
      : createLambdaRuntime(ctx, args.runtime?.lambda ?? {}, target as LambdaConnectionTarget);

    this.functionArn = result.functionArn;
    this.functionName = result.functionName;
    this.aliasArn = result.aliasArn;
    this.roleArn = result.roleArn;
    this.roleName = result.roleName;
    this.codedeployAppName = result.codedeployAppName;
    this.codedeployDeploymentGroupName = result.codedeployDeploymentGroupName;
    this.ecsServiceName = result.ecsServiceName;
    this.taskDefinitionArn = result.taskDefinitionArn;
    this.serviceUrl = target.routes.length > 0
      ? pulumi.output(target.routes[0].apiGatewayId)
          .apply((id) => `https://${id}.execute-api.us-east-1.amazonaws.com`)
      : empty;

    this.registerOutputs({
      functionArn: this.functionArn,
      functionName: this.functionName,
      aliasArn: this.aliasArn,
      roleArn: this.roleArn,
      roleName: this.roleName,
      codedeployAppName: this.codedeployAppName,
      codedeployDeploymentGroupName: this.codedeployDeploymentGroupName,
      ecsServiceName: this.ecsServiceName,
      taskDefinitionArn: this.taskDefinitionArn,
      serviceUrl: this.serviceUrl,
    });
  }

  invoker(opts?: { envVarName?: string }): Connection<ServiceTarget> {
    const envKey = opts?.envVarName
      ?? `SERVICE_URL_${this.resourceName.replace(/-/g, "_").toUpperCase()}`;
    const functionArn = this.functionArn;
    const aliasArn = this.aliasArn;
    const serviceUrl = this.serviceUrl;
    return {
      bind(target) {
        target.addEnvVar(envKey, serviceUrl);
        target.addPolicy(["lambda:InvokeFunction"], functionArn);
        target.addPolicy(["lambda:InvokeFunction"], aliasArn);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Lambda runtime
// ---------------------------------------------------------------------------

function createLambdaRuntime(
  ctx: RuntimeContext,
  config: LambdaConfig,
  target: LambdaConnectionTarget,
): RuntimeResult {
  const { name, namePrefix, stage, defaultTags } = ctx;
  const parent = ctx.parent;
  const packageType = config.packageType ?? "Zip";
  const isZip = packageType === "Zip";
  const isImage = packageType === "Image";
  const architecture = config.architecture ?? "arm64";

  const resolved = pulumi.all([ctx.stage, ctx.envName, pulumi.output(config.memory ?? 512), pulumi.output(config.timeout ?? 30)])
    .apply(([s, e, memory, timeout]) => resolveWithDefaults(s, e, ctx.overrides, { memory, timeout }));

  // IAM
  const role = new aws.iam.Role(
    `${name}-lambda-role`,
    {
      name: pulumi.interpolate`${namePrefix}-lambda`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
        }],
      }),
      tags: defaultTags,
    },
    { parent },
  );

  new aws.iam.RolePolicyAttachment(
    `${name}-lambda-basic`,
    {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    },
    { parent },
  );

  if (target.needsVpc) {
    new aws.iam.RolePolicyAttachment(
      `${name}-lambda-vpc`,
      {
        role: role.name,
        policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
      },
      { parent },
    );
  }

  for (const [i, policy] of target.policies.entries()) {
    new aws.iam.RolePolicy(
      `${name}-policy-${i}`,
      {
        name: pulumi.interpolate`${namePrefix}-conn-${i}`,
        role: role.name,
        policy: pulumi.output(policy.resource).apply((resource) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: policy.actions,
              Resource: resource,
            }],
          }),
        ),
      },
      { parent },
    );
  }

  // Logs
  const logGroup = new aws.cloudwatch.LogGroup(
    `${name}-logs`,
    {
      name: pulumi.interpolate`/aws/lambda/${namePrefix}`,
      retentionInDays: resolved.apply((r) => r.logRetentionDays),
      tags: defaultTags,
    },
    { parent },
  );

  // Artifact source
  const artifactBucket = isZip
    ? stage.apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/artifact-bucket` })).apply((p) => p.value)
    : empty;

  const lambdaSgId = target.needsVpc
    ? stage.apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/lambda-sg-id` })).apply((p) => p.value)
    : empty;

  const layers = target.layers.size > 0 ? [...target.layers] : undefined;

  // Function
  const fn = new aws.lambda.Function(
    `${name}-fn`,
    {
      name: namePrefix,
      role: role.arn,
      memorySize: resolved.apply((s) => s.memory),
      timeout: resolved.apply((s) => s.timeout),
      architectures: [architecture],
      publish: true,
      packageType,
      handler: isZip ? (config.handler ?? "handler.handler") : undefined,
      runtime: isZip ? (config.lambdaRuntime ?? "nodejs20.x") : undefined,
      s3Bucket: isZip ? artifactBucket : undefined,
      s3Key: isZip
        ? (config.sha
            ? pulumi.interpolate`${ctx.serviceName}/${config.sha}.zip`
            : pulumi.interpolate`${ctx.serviceName}/latest.zip`)
        : undefined,
      imageUri: isImage ? config.imageUri : undefined,
      layers,
      environment: { variables: ctx.allEnvVars },
      vpcConfig: target.needsVpc
        ? { subnetIds: ctx.privateSubnetIds, securityGroupIds: [lambdaSgId] }
        : undefined,
      tags: defaultTags,
    },
    { parent, dependsOn: [logGroup] },
  );

  // Alias
  const alias = new aws.lambda.Alias(
    `${name}-alias`,
    {
      name: "live",
      functionName: fn.name,
      functionVersion: fn.version,
    },
    { parent, ignoreChanges: ["functionVersion", "routingConfig"] },
  );

  // CodeDeploy
  const codedeployRole = new aws.iam.Role(
    `${name}-codedeploy-role`,
    {
      name: pulumi.interpolate`${namePrefix}-codedeploy`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "codedeploy.amazonaws.com" },
        }],
      }),
      tags: defaultTags,
    },
    { parent },
  );

  new aws.iam.RolePolicyAttachment(
    `${name}-codedeploy-policy`,
    {
      role: codedeployRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
    },
    { parent },
  );

  const codedeployApp = new aws.codedeploy.Application(
    `${name}-codedeploy-app`,
    {
      computePlatform: "Lambda",
      name: namePrefix,
      tags: defaultTags,
    },
    { parent },
  );

  new aws.codedeploy.DeploymentGroup(
    `${name}-codedeploy-dg`,
    {
      appName: codedeployApp.name,
      deploymentGroupName: namePrefix,
      deploymentConfigName: resolved.apply((r) => r.deploymentConfig),
      serviceRoleArn: codedeployRole.arn,
      deploymentStyle: {
        deploymentType: "BLUE_GREEN",
        deploymentOption: "WITH_TRAFFIC_CONTROL",
      },
    },
    { parent },
  );

  // Event source mappings
  for (const [i, eventSource] of target.eventSources.entries()) {
    new aws.lambda.EventSourceMapping(
      `${name}-esm-${i}`,
      {
        eventSourceArn: eventSource.arn,
        functionName: fn.arn,
        batchSize: eventSource.batchSize,
        enabled: true,
      },
      { parent },
    );
  }

  // API Gateway routes
  if (target.routes.length > 0) {
    new aws.lambda.Permission(
      `${name}-apigw-permission`,
      {
        statementId: "AllowAPIGatewayInvoke",
        action: "lambda:InvokeFunction",
        function: fn.name,
        qualifier: alias.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.all([aws.getRegionOutput().name, aws.getCallerIdentityOutput().accountId, target.routes[0].apiGatewayId])
          .apply(([region, accountId, apiId]) => `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*`),
      },
      { parent },
    );

    const integration = new aws.apigatewayv2.Integration(
      `${name}-apigw-int`,
      {
        apiId: target.routes[0].apiGatewayId,
        integrationType: "AWS_PROXY",
        integrationUri: alias.arn,
        integrationMethod: "POST",
        payloadFormatVersion: "2.0",
      },
      { parent },
    );

    createRoutes(name, target.routes, integration.id, parent);
  }

  return {
    functionArn: fn.arn,
    functionName: fn.name,
    aliasArn: alias.arn,
    roleArn: role.arn,
    roleName: role.name,
    codedeployAppName: namePrefix,
    codedeployDeploymentGroupName: namePrefix,
    ecsServiceName: empty,
    taskDefinitionArn: empty,
  };
}

// ---------------------------------------------------------------------------
// ECS runtime
// ---------------------------------------------------------------------------

function createEcsRuntime(
  ctx: RuntimeContext,
  config: EcsConfig,
  target: EcsConnectionTarget,
): RuntimeResult {
  const { name, namePrefix, stage, envName, serviceName, defaultTags } = ctx;
  const parent = ctx.parent;
  const port = config.port ?? 8080;
  const architecture = config.architecture ?? "arm64";

  const resolved = pulumi.all([ctx.stage, ctx.envName, pulumi.output(config.cpu ?? 256), pulumi.output(config.memory ?? 512), pulumi.output(config.desiredCount ?? 1)])
    .apply(([s, e, cpu, memory, desiredCount]) => resolveWithDefaults(s, e, ctx.overrides, { cpu, memory, desiredCount }));

  const ssmPrefix = pulumi.interpolate`/${stage}/${envName}`;
  const ecsClusterArn = ssmPrefix
    .apply((p) => aws.ssm.getParameter({ name: `${p}/ecs-cluster-arn` }))
    .apply((r) => r.value);

  // CodeDeploy requires cluster name, not ARN — extract from "arn:aws:ecs:region:account:cluster/name"
  const ecsClusterName = ecsClusterArn.apply((arn) => arn.split("/").pop()!);

  // IAM — execution role (pulls images) and task role (app permissions)
  const executionRole = new aws.iam.Role(
    `${name}-ecs-exec-role`,
    {
      name: pulumi.interpolate`${namePrefix}-ecs-exec`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
        }],
      }),
      tags: defaultTags,
    },
    { parent },
  );

  new aws.iam.RolePolicyAttachment(
    `${name}-ecs-exec-policy`,
    {
      role: executionRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    },
    { parent },
  );

  const taskRole = new aws.iam.Role(
    `${name}-ecs-task-role`,
    {
      name: pulumi.interpolate`${namePrefix}-ecs-task`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
        }],
      }),
      tags: defaultTags,
    },
    { parent },
  );

  for (const [i, policy] of target.policies.entries()) {
    new aws.iam.RolePolicy(
      `${name}-policy-${i}`,
      {
        name: pulumi.interpolate`${namePrefix}-conn-${i}`,
        role: taskRole.name,
        policy: pulumi.output(policy.resource).apply((resource) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: policy.actions,
              Resource: resource,
            }],
          }),
        ),
      },
      { parent },
    );
  }

  // Logs
  const logGroup = new aws.cloudwatch.LogGroup(
    `${name}-ecs-logs`,
    {
      name: pulumi.interpolate`/ecs/${namePrefix}`,
      retentionInDays: resolved.apply((r) => r.logRetentionDays),
      tags: defaultTags,
    },
    { parent },
  );

  // Task definition
  const region = aws.getRegionOutput();

  const taskDef = new aws.ecs.TaskDefinition(
    `${name}-task-def`,
    {
      family: namePrefix,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: resolved.apply((s) => String(s.cpu)),
      memory: resolved.apply((s) => String(s.memory)),
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      runtimePlatform: {
        operatingSystemFamily: "LINUX",
        cpuArchitecture: architecture === "arm64" ? "ARM64" : "X86_64",
      },
      containerDefinitions: pulumi
        .all([serviceName, config.imageUri ?? "", ctx.allEnvVars, logGroup.name, region.name])
        .apply(([svcName, image, envVars, logGroupName, regionName]) =>
          JSON.stringify([{
            name: svcName,
            image,
            essential: true,
            portMappings: [{ containerPort: port, protocol: "tcp" }],
            environment: Object.entries(envVars).map(([k, v]) => ({ name: k, value: String(v) })),
            secrets: target.containerSecrets.length > 0 ? target.containerSecrets : undefined,
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": regionName,
                "awslogs-stream-prefix": svcName,
              },
            },
          }]),
        ),
      tags: defaultTags,
    },
    { parent },
  );

  // Security group — allow traffic from shared ALB
  const albSgId = ssmPrefix
    .apply((p) => aws.ssm.getParameter({ name: `${p}/alb-sg-id` }))
    .apply((r) => r.value);

  const taskSg = new aws.ec2.SecurityGroup(
    `${name}-ecs-task-sg`,
    {
      name: pulumi.interpolate`${namePrefix}-ecs-task`,
      description: pulumi.interpolate`ECS task security group for ${serviceName}`,
      vpcId: ctx.vpcId,
      egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
      tags: defaultTags,
    },
    { parent },
  );

  new aws.ec2.SecurityGroupRule(
    `${name}-ecs-from-alb`,
    {
      type: "ingress",
      fromPort: port,
      toPort: port,
      protocol: "tcp",
      sourceSecurityGroupId: albSgId,
      securityGroupId: taskSg.id,
      description: "From shared ALB",
    },
    { parent },
  );

  // ALB target groups (blue + green for CodeDeploy)
  const albListenerArn = ssmPrefix
    .apply((p) => aws.ssm.getParameter({ name: `${p}/alb-listener-arn` }))
    .apply((r) => r.value);

  const albTestListenerArn = ssmPrefix
    .apply((p) => aws.ssm.getParameter({ name: `${p}/alb-test-listener-arn` }))
    .apply((r) => r.value);

  const tgBlue = new aws.lb.TargetGroup(
    `${name}-tg-blue`,
    {
      name: pulumi.interpolate`${namePrefix}-blue`,
      port,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: ctx.vpcId,
      healthCheck: { path: config.healthCheckPath ?? "/health", interval: 15, healthyThreshold: 2, unhealthyThreshold: 3 },
      tags: defaultTags,
    },
    { parent },
  );

  const tgGreen = new aws.lb.TargetGroup(
    `${name}-tg-green`,
    {
      name: pulumi.interpolate`${namePrefix}-green`,
      port,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: ctx.vpcId,
      healthCheck: { path: config.healthCheckPath ?? "/health", interval: 15, healthyThreshold: 2, unhealthyThreshold: 3 },
      tags: defaultTags,
    },
    { parent },
  );

  // ALB listener rules (path-based routing to this service)
  if (target.routes.length > 0) {
    const allPaths = target.routes.flatMap((r) => r.routes ?? []).map(routeKeyToPathPattern);

    new aws.lb.ListenerRule(
      `${name}-alb-rule`,
      {
        listenerArn: albListenerArn,
        conditions: [{ pathPattern: { values: allPaths } }],
        actions: [{ type: "forward", targetGroupArn: tgBlue.arn }],
        tags: defaultTags,
      },
      { parent, ignoreChanges: ["actions"] },
    );

    new aws.lb.ListenerRule(
      `${name}-alb-test-rule`,
      {
        listenerArn: albTestListenerArn,
        conditions: [{ pathPattern: { values: allPaths } }],
        actions: [{ type: "forward", targetGroupArn: tgGreen.arn }],
        tags: defaultTags,
      },
      { parent, ignoreChanges: ["actions"] },
    );

    // API Gateway → ALB integration (via VPC Link)
    const vpcLinkId = target.routes[0].vpcLinkId;
    if (vpcLinkId) {
      const albDnsName = ssmPrefix
        .apply((p) => aws.ssm.getParameter({ name: `${p}/alb-dns-name` }))
        .apply((r) => r.value);

      const integration = new aws.apigatewayv2.Integration(
        `${name}-apigw-int`,
        {
          apiId: target.routes[0].apiGatewayId,
          integrationType: "HTTP_PROXY",
          integrationUri: albListenerArn,
          integrationMethod: "ANY",
          connectionType: "VPC_LINK",
          connectionId: vpcLinkId,
        },
        { parent },
      );

      createRoutes(name, target.routes, integration.id, parent);
    }
  }

  // CodeDeploy — blue/green traffic shifting via ALB
  const codedeployRole = new aws.iam.Role(
    `${name}-ecs-codedeploy-role`,
    {
      name: pulumi.interpolate`${namePrefix}-ecs-codedeploy`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "codedeploy.amazonaws.com" },
        }],
      }),
      tags: defaultTags,
    },
    { parent },
  );

  new aws.iam.RolePolicyAttachment(
    `${name}-ecs-codedeploy-policy`,
    {
      role: codedeployRole.name,
      policyArn: "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS",
    },
    { parent },
  );

  const codedeployApp = new aws.codedeploy.Application(
    `${name}-ecs-codedeploy-app`,
    {
      computePlatform: "ECS",
      name: namePrefix,
      tags: defaultTags,
    },
    { parent },
  );

  new aws.codedeploy.DeploymentGroup(
    `${name}-ecs-codedeploy-dg`,
    {
      appName: codedeployApp.name,
      deploymentGroupName: namePrefix,
      deploymentConfigName: "CodeDeployDefault.ECSAllAtOnce",
      serviceRoleArn: codedeployRole.arn,
      deploymentStyle: {
        deploymentType: "BLUE_GREEN",
        deploymentOption: "WITH_TRAFFIC_CONTROL",
      },
      blueGreenDeploymentConfig: {
        deploymentReadyOption: { actionOnTimeout: "CONTINUE_DEPLOYMENT" },
        terminateBlueInstancesOnDeploymentSuccess: { action: "TERMINATE", terminationWaitTimeInMinutes: 5 },
      },
      ecsService: {
        clusterName: ecsClusterName,
        serviceName: namePrefix,
      },
      loadBalancerInfo: {
        targetGroupPairInfo: {
          prodTrafficRoute: { listenerArns: [albListenerArn] },
          testTrafficRoute: { listenerArns: [albTestListenerArn] },
          targetGroups: [
            { name: tgBlue.name },
            { name: tgGreen.name },
          ],
        },
      },
      autoRollbackConfiguration: {
        enabled: true,
        events: ["DEPLOYMENT_FAILURE"],
      },
    },
    { parent },
  );

  // ECS service — CODE_DEPLOY deployment controller for blue/green
  const ecsService = new aws.ecs.Service(
    `${name}-ecs-svc`,
    {
      name: namePrefix,
      cluster: ecsClusterArn,
      taskDefinition: taskDef.arn,
      desiredCount: resolved.apply((s) => s.desiredCount),
      launchType: "FARGATE",
      deploymentController: { type: "CODE_DEPLOY" },
      networkConfiguration: {
        subnets: ctx.privateSubnetIds,
        securityGroups: [taskSg.id],
      },
      loadBalancers: [{
        targetGroupArn: tgBlue.arn,
        containerName: serviceName,
        containerPort: port,
      }],
    },
    { parent, ignoreChanges: ["taskDefinition", "loadBalancers"] },
  );

  return {
    functionArn: empty,
    functionName: empty,
    aliasArn: empty,
    roleArn: taskRole.arn,
    roleName: taskRole.name,
    codedeployAppName: namePrefix,
    codedeployDeploymentGroupName: namePrefix,
    ecsServiceName: ecsService.name,
    taskDefinitionArn: taskDef.arn,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  memory: number;
  timeout: number;
  cpu: number;
  desiredCount: number;
  logRetentionDays: number;
  deploymentConfig: string;
}

function resolveWithDefaults(
  s: string,
  e: string,
  overrides: Overrides<AsServiceOverrides> | undefined,
  runtimeDefaults: Partial<AsServiceOverrides>,
): ResolvedConfig {
  const userOv = overrides ? resolveOverrides(s, e, overrides) : {};
  const defaultOv = resolveOverrides(s, e, DEFAULT_OVERRIDES);
  return {
    memory: userOv.memory ?? defaultOv.memory ?? runtimeDefaults.memory ?? 512,
    timeout: userOv.timeout ?? defaultOv.timeout ?? runtimeDefaults.timeout ?? 30,
    cpu: userOv.cpu ?? defaultOv.cpu ?? runtimeDefaults.cpu ?? 256,
    desiredCount: userOv.desiredCount ?? defaultOv.desiredCount ?? runtimeDefaults.desiredCount ?? 1,
    logRetentionDays: userOv.logRetentionDays ?? defaultOv.logRetentionDays ?? 30,
    deploymentConfig: userOv.deploymentConfig ?? defaultOv.deploymentConfig ?? runtimeDefaults.deploymentConfig ?? "CodeDeployDefault.LambdaAllAtOnce",
  };
}

function routeKeyToPathPattern(routeKey: string): string {
  const path = routeKey.includes(" ") ? routeKey.split(" ")[1] : routeKey;
  return path.replace("{proxy+}", "*");
}

function createRoutes(
  name: string,
  routes: { apiGatewayId: pulumi.Input<string>; routes?: string[] }[],
  integrationId: pulumi.Output<string>,
  parent: pulumi.Resource,
): void {
  const allRouteKeys = routes.flatMap((r) => r.routes ?? ["$default"]);
  const apiGatewayId = routes[0].apiGatewayId;

  for (const routeKey of allRouteKeys) {
    const safeName = routeKey.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    new aws.apigatewayv2.Route(
      `${name}-route-${safeName}`,
      {
        apiId: apiGatewayId,
        routeKey,
        target: pulumi.interpolate`integrations/${integrationId}`,
      },
      { parent },
    );
  }
}
