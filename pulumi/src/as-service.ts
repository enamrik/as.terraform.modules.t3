/**
 * AsService — unified service module that deploys to Lambda or ECS Fargate.
 *
 * Components declare what they are (a service), not how they run.
 * Wiring is handled by connections — typed edges between resources and
 * this compute target. AsService creates a ConnectionTarget (Lambda or ECS),
 * runs all connections through it, then builds AWS resources from the
 * accumulated state.
 *
 * Resources created:
 * - Lambda: function, alias, CodeDeploy app + deployment group, IAM
 * - ECS: task definition, service, ALB, security groups, IAM
 * - Shared: API Gateway integration + routes (from gateway connections)
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
// Built-in defaults — cost-saving for ephemeral/local environments.
// User overrides always win over these.
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
    memory: 256,
    timeout: 15,
    desiredCount: 1,
    logRetentionDays: 3,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
  "local-*": {
    memory: 256,
    timeout: 15,
    desiredCount: 1,
    logRetentionDays: 1,
    deploymentConfig: "CodeDeployDefault.LambdaAllAtOnce",
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsServiceArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;
  runtime?: "lambda" | "ecs";

  // Artifact
  imageUri?: pulumi.Input<string>;
  sha?: pulumi.Input<string>;

  // Sizing
  memory?: pulumi.Input<number>;
  timeout?: pulumi.Input<number>;
  cpu?: pulumi.Input<number>;
  desiredCount?: pulumi.Input<number>;

  // Lambda-specific
  packageType?: "Zip" | "Image";
  handler?: pulumi.Input<string>;
  lambdaRuntime?: pulumi.Input<string>;
  architectures?: pulumi.Input<string>[];
  deploymentConfig?: pulumi.Input<string>;

  // ECS-specific
  port?: pulumi.Input<number>;
  healthCheckPath?: pulumi.Input<string>;
  deployStrategy?: "rolling" | "codedeploy";

  // Connections — typed wiring to resources
  connections?: Connection<ServiceTarget>[];

  // Per-environment sizing overrides (glob patterns on envName or stage/envName)
  overrides?: Overrides<AsServiceOverrides>;

  // Direct env vars (for simple static values)
  environmentVariables?: pulumi.Input<Record<string, string>>;

  tags?: pulumi.Input<Record<string, string>>;
}

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
    const runtime = args.runtime ?? "lambda";
    const isLambda = runtime === "lambda";
    const isEcs = runtime === "ecs";
    const deployStrategy = args.deployStrategy ?? (isEcs ? "rolling" : "codedeploy");
    const packageType = args.packageType ?? "Zip";
    const isZip = isLambda && packageType === "Zip";
    const isImage = (isLambda && packageType === "Image") || isEcs;
    const architectures = args.architectures ?? ["arm64"];

    // -----------------------------------------------------------------------
    // Resolve sizing: base props + environment overrides
    // -----------------------------------------------------------------------

    const resolved = pulumi
      .all([
        stage,
        envName,
        pulumi.output(args.memory ?? 512),
        pulumi.output(args.timeout ?? 30),
        pulumi.output(args.cpu ?? 256),
        pulumi.output(args.desiredCount ?? 1),
        pulumi.output(args.deploymentConfig ?? "CodeDeployDefault.LambdaAllAtOnce"),
      ])
      .apply(([s, e, mem, to, cpu, dc, depCfg]) => {
        const userOv = args.overrides ? resolveOverrides(s, e, args.overrides) : {};
        const defaultOv = resolveOverrides(s, e, DEFAULT_OVERRIDES);
        return {
          memory: userOv.memory ?? defaultOv.memory ?? mem,
          timeout: userOv.timeout ?? defaultOv.timeout ?? to,
          cpu: userOv.cpu ?? defaultOv.cpu ?? cpu,
          desiredCount: userOv.desiredCount ?? defaultOv.desiredCount ?? dc,
          logRetentionDays: userOv.logRetentionDays ?? defaultOv.logRetentionDays ?? 30,
          deploymentConfig: userOv.deploymentConfig ?? defaultOv.deploymentConfig ?? depCfg,
        };
      });

    const namePrefix = pulumi.interpolate`${stage}-${envName}-${serviceName}`;

    const defaultTags = pulumi.output(args.tags ?? {}).apply((extra) => ({
      environment: stage,
      env_name: envName,
      service: serviceName,
      runtime,
      project: "as-platform",
      "managed-by": "pulumi",
      ...extra,
    }));

    // -----------------------------------------------------------------------
    // Bind connections to a target — accumulates env vars, policies, etc.
    // -----------------------------------------------------------------------

    const target = isLambda
      ? new LambdaConnectionTarget()
      : new EcsConnectionTarget();

    for (const connection of args.connections ?? []) {
      connection.bind(target);
    }

    // -----------------------------------------------------------------------
    // Merge env vars: connections + explicit environmentVariables
    // -----------------------------------------------------------------------

    const connectionEnvVars = target.envVars;
    const allEnvVars = pulumi.output(args.environmentVariables ?? {}).apply((custom) => ({
      STAGE: stage,
      ENV_NAME: envName,
      ...connectionEnvVars,
      ...custom,
    }));

    // -----------------------------------------------------------------------
    // SSM Lookups — foundation context
    // -----------------------------------------------------------------------

    const vpcId = target.needsVpc || isEcs
      ? stage
          .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/vpc-id` }))
          .apply((p) => p.value)
      : pulumi.output("");

    const privateSubnetIds = target.needsVpc || isEcs
      ? stage
          .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/private-subnet-ids` }))
          .apply((p) => JSON.parse(p.value) as string[])
      : pulumi.output([] as string[]);

    const lambdaSgId = isLambda && target.needsVpc
      ? stage
          .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/lambda-sg-id` }))
          .apply((p) => p.value)
      : pulumi.output("");

    const artifactBucket = isZip
      ? stage
          .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/artifact-bucket` }))
          .apply((p) => p.value)
      : pulumi.output("");

    const ecsClusterArn = isEcs
      ? pulumi.all([stage, envName])
          .apply(([s, e]) => aws.ssm.getParameter({ name: `/${s}/${e}/ecs-cluster-arn` }))
          .apply((p) => p.value)
      : pulumi.output("");

    // -----------------------------------------------------------------------
    // Lambda Runtime
    // -----------------------------------------------------------------------

    let lambdaFunction: aws.lambda.Function | undefined;
    let lambdaAlias: aws.lambda.Alias | undefined;
    let lambdaRoleName: pulumi.Output<string> = pulumi.output("");
    let lambdaRoleArn: pulumi.Output<string> = pulumi.output("");

    if (isLambda) {
      const lambdaTarget = target as LambdaConnectionTarget;

      const lambdaRole = new aws.iam.Role(
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
        { parent: this },
      );

      new aws.iam.RolePolicyAttachment(
        `${name}-lambda-basic`,
        {
          role: lambdaRole.name,
          policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        },
        { parent: this },
      );

      if (target.needsVpc) {
        new aws.iam.RolePolicyAttachment(
          `${name}-lambda-vpc`,
          {
            role: lambdaRole.name,
            policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
          },
          { parent: this },
        );
      }

      // Connection-accumulated IAM policies
      for (const [i, policy] of lambdaTarget.policies.entries()) {
        new aws.iam.RolePolicy(
          `${name}-policy-${i}`,
          {
            name: pulumi.interpolate`${namePrefix}-conn-${i}`,
            role: lambdaRole.name,
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
          { parent: this },
        );
      }

      lambdaRoleName = lambdaRole.name;
      lambdaRoleArn = lambdaRole.arn;

      const logGroup = new aws.cloudwatch.LogGroup(
        `${name}-logs`,
        {
          name: pulumi.interpolate`/aws/lambda/${namePrefix}`,
          retentionInDays: resolved.apply((r) => r.logRetentionDays),
          tags: defaultTags,
        },
        { parent: this },
      );

      const layers = lambdaTarget.layers.size > 0
        ? [...lambdaTarget.layers]
        : undefined;

      lambdaFunction = new aws.lambda.Function(
        `${name}-fn`,
        {
          name: namePrefix,
          role: lambdaRole.arn,
          memorySize: resolved.apply((s) => s.memory),
          timeout: resolved.apply((s) => s.timeout),
          architectures,
          publish: true,
          packageType,
          handler: isZip ? (args.handler ?? "handler.handler") : undefined,
          runtime: isZip ? (args.lambdaRuntime ?? "nodejs20.x") : undefined,
          s3Bucket: isZip ? artifactBucket : undefined,
          s3Key: isZip
            ? (args.sha
                ? pulumi.interpolate`${serviceName}/${args.sha}.zip`
                : pulumi.interpolate`${serviceName}/latest.zip`)
            : undefined,
          imageUri: isImage ? args.imageUri : undefined,
          layers,
          environment: { variables: allEnvVars },
          vpcConfig: target.needsVpc
            ? {
                subnetIds: privateSubnetIds,
                securityGroupIds: [lambdaSgId],
              }
            : undefined,
          tags: defaultTags,
        },
        { parent: this, dependsOn: [logGroup] },
      );

      lambdaAlias = new aws.lambda.Alias(
        `${name}-alias`,
        {
          name: "live",
          functionName: lambdaFunction.name,
          functionVersion: lambdaFunction.version,
        },
        {
          parent: this,
          ignoreChanges: ["functionVersion", "routingConfig"],
        },
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
        { parent: this },
      );

      new aws.iam.RolePolicyAttachment(
        `${name}-codedeploy-policy`,
        {
          role: codedeployRole.name,
          policyArn: "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
        },
        { parent: this },
      );

      const codedeployApp = new aws.codedeploy.Application(
        `${name}-codedeploy-app`,
        {
          computePlatform: "Lambda",
          name: namePrefix,
          tags: defaultTags,
        },
        { parent: this },
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
        { parent: this },
      );

      // Event source mappings from connections
      for (const [i, eventSource] of lambdaTarget.eventSources.entries()) {
        new aws.lambda.EventSourceMapping(
          `${name}-esm-${i}`,
          {
            eventSourceArn: eventSource.arn,
            functionName: lambdaFunction.arn,
            batchSize: eventSource.batchSize,
            enabled: true,
          },
          { parent: this },
        );
      }

      // API Gateway routes from connections
      if (lambdaTarget.routes.length > 0) {
        new aws.lambda.Permission(
          `${name}-apigw-permission`,
          {
            statementId: "AllowAPIGatewayInvoke",
            action: "lambda:InvokeFunction",
            function: lambdaFunction.name,
            qualifier: lambdaAlias.name,
            principal: "apigateway.amazonaws.com",
            sourceArn: pulumi.all([aws.getRegionOutput().name, aws.getCallerIdentityOutput().accountId, lambdaTarget.routes[0].apiGatewayId])
              .apply(([region, accountId, apiId]) => `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*`),
          },
          { parent: this },
        );

        const integration = new aws.apigatewayv2.Integration(
          `${name}-apigw-int`,
          {
            apiId: lambdaTarget.routes[0].apiGatewayId,
            integrationType: "AWS_PROXY",
            integrationUri: lambdaAlias.arn,
            integrationMethod: "POST",
            payloadFormatVersion: "2.0",
          },
          { parent: this },
        );

        this.createRoutes(name, lambdaTarget.routes, integration.id);
      }
    }

    // -----------------------------------------------------------------------
    // ECS Runtime
    // -----------------------------------------------------------------------

    let ecsService: aws.ecs.Service | undefined;
    let ecsTaskDef: aws.ecs.TaskDefinition | undefined;
    let ecsTaskRoleArn: pulumi.Output<string> = pulumi.output("");
    let ecsTaskRoleName: pulumi.Output<string> = pulumi.output("");
    let ecsListenerArn: pulumi.Output<string> | undefined;

    if (isEcs) {
      const ecsTarget = target as EcsConnectionTarget;
      const port = args.port ?? 8080;

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
        { parent: this },
      );

      new aws.iam.RolePolicyAttachment(
        `${name}-ecs-exec-policy`,
        {
          role: executionRole.name,
          policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        },
        { parent: this },
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
        { parent: this },
      );

      ecsTaskRoleArn = taskRole.arn;
      ecsTaskRoleName = taskRole.name;

      // Connection-accumulated IAM policies
      for (const [i, policy] of ecsTarget.policies.entries()) {
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
          { parent: this },
        );
      }

      const ecsLogGroup = new aws.cloudwatch.LogGroup(
        `${name}-ecs-logs`,
        {
          name: pulumi.interpolate`/ecs/${namePrefix}`,
          retentionInDays: resolved.apply((r) => r.logRetentionDays),
          tags: defaultTags,
        },
        { parent: this },
      );

      const region = aws.getRegionOutput();

      ecsTaskDef = new aws.ecs.TaskDefinition(
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
            cpuArchitecture: architectures[0] === "arm64" ? "ARM64" : "X86_64",
          },
          containerDefinitions: pulumi
            .all([
              serviceName,
              args.imageUri ?? "",
              allEnvVars,
              ecsLogGroup.name,
              region.name,
            ])
            .apply(([svcName, image, envVars, logGroupName, regionName]) =>
              JSON.stringify([
                {
                  name: svcName,
                  image,
                  essential: true,
                  portMappings: [{ containerPort: port, protocol: "tcp" }],
                  environment: Object.entries(envVars).map(([k, v]) => ({
                    name: k,
                    value: String(v),
                  })),
                  secrets: ecsTarget.containerSecrets.length > 0
                    ? ecsTarget.containerSecrets
                    : undefined,
                  logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                      "awslogs-group": logGroupName,
                      "awslogs-region": regionName,
                      "awslogs-stream-prefix": svcName,
                    },
                  },
                },
              ]),
            ),
          tags: defaultTags,
        },
        { parent: this },
      );

      // Security groups
      const taskSg = new aws.ec2.SecurityGroup(
        `${name}-ecs-task-sg`,
        {
          name: pulumi.interpolate`${namePrefix}-ecs-task`,
          description: pulumi.interpolate`ECS task security group for ${serviceName}`,
          vpcId,
          egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
          tags: defaultTags,
        },
        { parent: this },
      );

      let targetGroup: aws.lb.TargetGroup | undefined;
      let targetGroupGreen: aws.lb.TargetGroup | undefined;
      let listener: aws.lb.Listener | undefined;
      let testListener: aws.lb.Listener | undefined;
      const useCodeDeploy = deployStrategy === "codedeploy";

      if (ecsTarget.routes.length > 0) {
        const albSg = new aws.ec2.SecurityGroup(
          `${name}-alb-sg`,
          {
            name: pulumi.interpolate`${namePrefix}-alb`,
            description: pulumi.interpolate`ALB security group for ${serviceName}`,
            vpcId,
            ingress: [{
              fromPort: 80,
              toPort: 80,
              protocol: "tcp",
              cidrBlocks: ["0.0.0.0/0"],
              description: "HTTP from VPC Link",
            }, ...(useCodeDeploy ? [{
              fromPort: 8080,
              toPort: 8080,
              protocol: "tcp",
              cidrBlocks: ["0.0.0.0/0"],
              description: "Test listener for CodeDeploy",
            }] : [])],
            egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
            tags: defaultTags,
          },
          { parent: this },
        );

        new aws.ec2.SecurityGroupRule(
          `${name}-ecs-from-alb`,
          {
            type: "ingress",
            fromPort: port,
            toPort: port,
            protocol: "tcp",
            sourceSecurityGroupId: albSg.id,
            securityGroupId: taskSg.id,
            description: "From ALB",
          },
          { parent: this },
        );

        const alb = new aws.lb.LoadBalancer(
          `${name}-alb`,
          {
            name: namePrefix.apply((p) => p.substring(0, 32)),
            internal: true,
            loadBalancerType: "application",
            securityGroups: [albSg.id],
            subnets: privateSubnetIds,
            tags: defaultTags,
          },
          { parent: this },
        );

        targetGroup = new aws.lb.TargetGroup(
          `${name}-tg`,
          {
            name: namePrefix.apply((p) => `${p.substring(0, 26)}-blue`),
            port,
            protocol: "HTTP",
            vpcId,
            targetType: "ip",
            healthCheck: {
              path: args.healthCheckPath ?? "/health",
              protocol: "HTTP",
              healthyThreshold: 2,
              unhealthyThreshold: 3,
              timeout: 5,
              interval: 30,
            },
            tags: defaultTags,
          },
          { parent: this },
        );

        listener = new aws.lb.Listener(
          `${name}-listener`,
          {
            loadBalancerArn: alb.arn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
          },
          { parent: this },
        );

        ecsListenerArn = listener.arn;

        if (useCodeDeploy) {
          targetGroupGreen = new aws.lb.TargetGroup(
            `${name}-tg-green`,
            {
              name: namePrefix.apply((p) => `${p.substring(0, 25)}-green`),
              port,
              protocol: "HTTP",
              vpcId,
              targetType: "ip",
              healthCheck: {
                path: args.healthCheckPath ?? "/health",
                protocol: "HTTP",
                healthyThreshold: 2,
                unhealthyThreshold: 3,
                timeout: 5,
                interval: 30,
              },
              tags: defaultTags,
            },
            { parent: this },
          );

          testListener = new aws.lb.Listener(
            `${name}-test-listener`,
            {
              loadBalancerArn: alb.arn,
              port: 8080,
              protocol: "HTTP",
              defaultActions: [{ type: "forward", targetGroupArn: targetGroupGreen.arn }],
            },
            { parent: this },
          );
        }

        // API Gateway → VPC Link → ALB integration
        const vpcLinkId = ecsTarget.routes[0].vpcLinkId;
        if (vpcLinkId) {
          const integration = new aws.apigatewayv2.Integration(
            `${name}-apigw-int`,
            {
              apiId: ecsTarget.routes[0].apiGatewayId,
              integrationType: "HTTP_PROXY",
              integrationUri: listener.arn,
              integrationMethod: "ANY",
              connectionType: "VPC_LINK",
              connectionId: vpcLinkId,
            },
            { parent: this },
          );

          this.createRoutes(name, ecsTarget.routes, integration.id);
        }
      }

      ecsService = new aws.ecs.Service(
        `${name}-ecs-svc`,
        {
          name: namePrefix,
          cluster: ecsClusterArn,
          taskDefinition: ecsTaskDef.arn,
          desiredCount: resolved.apply((s) => s.desiredCount),
          launchType: "FARGATE",
          networkConfiguration: {
            subnets: privateSubnetIds,
            securityGroups: [taskSg.id],
          },
          loadBalancers: targetGroup
            ? [{
                targetGroupArn: targetGroup.arn,
                containerName: serviceName,
                containerPort: port,
              }]
            : undefined,
          deploymentController: useCodeDeploy
            ? { type: "CODE_DEPLOY" }
            : undefined,
        },
        {
          parent: this,
          dependsOn: listener ? [listener] : [],
          ...(useCodeDeploy ? { ignoreChanges: ["taskDefinition", "loadBalancers"] } : {}),
        },
      );

      // CodeDeploy for ECS (opt-in)
      if (useCodeDeploy && targetGroup && targetGroupGreen && listener && testListener) {
        const ecsCodedeployRole = new aws.iam.Role(
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
          { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
          `${name}-ecs-codedeploy-policy`,
          {
            role: ecsCodedeployRole.name,
            policyArn: "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS",
          },
          { parent: this },
        );

        const ecsCodedeployApp = new aws.codedeploy.Application(
          `${name}-ecs-codedeploy-app`,
          {
            computePlatform: "ECS",
            name: namePrefix,
            tags: defaultTags,
          },
          { parent: this },
        );

        new aws.codedeploy.DeploymentGroup(
          `${name}-ecs-codedeploy-dg`,
          {
            appName: ecsCodedeployApp.name,
            deploymentGroupName: namePrefix,
            serviceRoleArn: ecsCodedeployRole.arn,
            deploymentConfigName: "CodeDeployDefault.ECSAllAtOnce",
            deploymentStyle: {
              deploymentType: "BLUE_GREEN",
              deploymentOption: "WITH_TRAFFIC_CONTROL",
            },
            blueGreenDeploymentConfig: {
              deploymentReadyOption: {
                actionOnTimeout: "CONTINUE_DEPLOYMENT",
              },
              terminateBlueInstancesOnDeploymentSuccess: {
                action: "TERMINATE",
                terminationWaitTimeInMinutes: 5,
              },
            },
            ecsService: {
              clusterName: ecsClusterArn.apply((arn) => arn.split("/").pop()!),
              serviceName: ecsService.name,
            },
            loadBalancerInfo: {
              targetGroupPairInfo: {
                prodTrafficRoute: {
                  listenerArns: [listener.arn],
                },
                testTrafficRoute: {
                  listenerArns: [testListener.arn],
                },
                targetGroups: [
                  { name: targetGroup.name },
                  { name: targetGroupGreen.name },
                ],
              },
            },
          },
          { parent: this, dependsOn: [ecsService] },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    this.functionArn = isLambda && lambdaFunction ? lambdaFunction.arn : pulumi.output("");
    this.functionName = isLambda && lambdaFunction ? lambdaFunction.name : pulumi.output("");
    this.aliasArn = isLambda && lambdaAlias ? lambdaAlias.arn : pulumi.output("");
    this.roleArn = isLambda ? lambdaRoleArn : ecsTaskRoleArn;
    this.roleName = isLambda ? lambdaRoleName : ecsTaskRoleName;
    this.codedeployAppName = (isLambda || (isEcs && deployStrategy === "codedeploy")) ? namePrefix : pulumi.output("");
    this.codedeployDeploymentGroupName = (isLambda || (isEcs && deployStrategy === "codedeploy")) ? namePrefix : pulumi.output("");
    this.ecsServiceName = isEcs && ecsService ? ecsService.name : pulumi.output("");
    this.taskDefinitionArn = isEcs && ecsTaskDef ? ecsTaskDef.arn : pulumi.output("");
    this.serviceUrl = target.routes.length > 0
      ? pulumi.output(target.routes[0].apiGatewayId)
          .apply((id) => `https://${id}.execute-api.us-east-1.amazonaws.com`)
      : pulumi.output("");

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

  /**
   * Returns a connection that grants another service permission to invoke this one.
   */
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

  private createRoutes(
    name: string,
    routes: { apiGatewayId: pulumi.Input<string>; routes?: string[] }[],
    integrationId: pulumi.Output<string>,
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
        { parent: this },
      );
    }
  }
}
