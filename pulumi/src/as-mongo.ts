/**
 * AsMongo — represents a MongoDB database connection managed via SSM.
 *
 * Not a Pulumi resource itself (the DB cluster lives in foundation).
 * This is a lightweight handle that exposes connection factories:
 *   db.reader() — grants SSM read + env var for connection string
 *
 * The connection string SSM path follows the convention:
 *   /{stage}/{envName}/{name}-connection-string
 */

import * as pulumi from "@pulumi/pulumi";
import type { Connection, HasEnvVars, HasSecrets, HasPolicy, HasVpc } from "./connections.js";

export interface AsMongoArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  ssmPath?: pulumi.Input<string>;
}

export class AsMongo {
  public readonly ssmPath: pulumi.Output<string>;

  private readonly resourceName: string;

  constructor(name: string, args: AsMongoArgs) {
    this.resourceName = name;
    const stage = pulumi.output(args.stage);
    const envName = pulumi.output(args.envName);
    this.ssmPath = args.ssmPath
      ? pulumi.output(args.ssmPath)
      : pulumi.interpolate`/${stage}/${envName}/${name}-connection-string`;
  }

  /**
   * Returns a connection that provides read access to this database.
   * Injects the connection string as a secret (SSM path) and enables VPC
   * (MongoDB is typically in private subnets).
   */
  reader(opts?: { envVarName?: string }): Connection<HasEnvVars & HasSecrets & HasPolicy & HasVpc> {
    const envKey = opts?.envVarName ?? "MONGO_URI";
    const ssmPath = this.ssmPath;
    const ssmArn = this.ssmPath.apply(
      (path) => `arn:aws:ssm:*:*:parameter${path}`,
    );
    return {
      bind(target) {
        target.addSecret(envKey, ssmPath);
        target.addPolicy(["ssm:GetParameter"], ssmArn);
        target.enableVpc();
      },
    };
  }
}
