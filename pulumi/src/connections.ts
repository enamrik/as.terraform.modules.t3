/**
 * Connection system — typed wiring between resources and compute targets.
 *
 * Resources expose connection factories (queue.publisher(), db.reader()).
 * Compute targets (AsService, AsWorker) accept Connection<T>[] where T
 * is the intersection of trait interfaces the target supports.
 * ConnectionTarget implementations handle runtime-specific wiring
 * (Lambda vs ECS handle secrets differently, for example).
 */

import * as pulumi from "@pulumi/pulumi";

// ---------------------------------------------------------------------------
// Trait interfaces — connections constrain on exactly what they need
// ---------------------------------------------------------------------------

export interface HasEnvVars {
  addEnvVar(name: string, value: pulumi.Input<string>): void;
}

export interface HasSecrets {
  addSecret(name: string, ssmPath: pulumi.Input<string>): void;
}

export interface HasPolicy {
  addPolicy(actions: string[], resource: pulumi.Input<string>): void;
}

export interface HasEventSources {
  addEventSource(config: EventSourceConfig): void;
}

export interface HasRoutes {
  addRoute(config: GatewayRouteConfig): void;
}

export interface HasVpc {
  enableVpc(): void;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface EventSourceConfig {
  arn: pulumi.Input<string>;
  batchSize: number;
}

export interface GatewayRouteConfig {
  apiGatewayId: pulumi.Input<string>;
  vpcLinkId?: pulumi.Input<string>;
  routes?: string[];
}

export interface PolicyConfig {
  actions: string[];
  resource: pulumi.Input<string>;
}

// ---------------------------------------------------------------------------
// Connection — the edge between a resource and a compute target
// ---------------------------------------------------------------------------

export interface Connection<T> {
  bind(target: T): void;
}

// ---------------------------------------------------------------------------
// Composite target types — what each compute type supports
// ---------------------------------------------------------------------------

export type ServiceTarget = HasEnvVars & HasSecrets & HasPolicy
  & HasEventSources & HasRoutes & HasVpc;

export type WorkerTarget = HasEnvVars & HasSecrets & HasPolicy
  & HasEventSources & HasVpc;

// ---------------------------------------------------------------------------
// Lambda connection target
// ---------------------------------------------------------------------------

const SECRETS_EXTENSION_ARN =
  "arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension-Arm64:12";

export class LambdaConnectionTarget implements ServiceTarget {
  readonly envVars: Record<string, pulumi.Input<string>> = {};
  readonly policies: PolicyConfig[] = [];
  readonly eventSources: EventSourceConfig[] = [];
  readonly routes: GatewayRouteConfig[] = [];
  readonly layers = new Set<string>();
  needsVpc = false;

  addEnvVar(name: string, value: pulumi.Input<string>): void {
    this.envVars[name] = value;
  }

  addSecret(name: string, ssmPath: pulumi.Input<string>): void {
    // Store SSM path — app resolves at cold start via the secrets extension
    this.envVars[`${name}_SSM`] = ssmPath;
    this.layers.add(SECRETS_EXTENSION_ARN);
  }

  addPolicy(actions: string[], resource: pulumi.Input<string>): void {
    this.policies.push({ actions, resource });
  }

  addEventSource(config: EventSourceConfig): void {
    this.eventSources.push(config);
  }

  addRoute(config: GatewayRouteConfig): void {
    this.routes.push(config);
  }

  enableVpc(): void {
    this.needsVpc = true;
  }
}

// ---------------------------------------------------------------------------
// ECS connection target
// ---------------------------------------------------------------------------

export interface ContainerSecret {
  name: string;
  valueFrom: pulumi.Input<string>;
}

export class EcsConnectionTarget implements ServiceTarget {
  readonly envVars: Record<string, pulumi.Input<string>> = {};
  readonly containerSecrets: ContainerSecret[] = [];
  readonly policies: PolicyConfig[] = [];
  readonly eventSources: EventSourceConfig[] = [];
  readonly routes: GatewayRouteConfig[] = [];
  needsVpc = false;

  addEnvVar(name: string, value: pulumi.Input<string>): void {
    this.envVars[name] = value;
  }

  addSecret(name: string, ssmPath: pulumi.Input<string>): void {
    // ECS resolves secrets natively at task startup
    this.containerSecrets.push({ name, valueFrom: ssmPath });
  }

  addPolicy(actions: string[], resource: pulumi.Input<string>): void {
    this.policies.push({ actions, resource });
  }

  addEventSource(config: EventSourceConfig): void {
    this.eventSources.push(config);
  }

  addRoute(config: GatewayRouteConfig): void {
    this.routes.push(config);
  }

  enableVpc(): void {
    this.needsVpc = true;
  }
}
