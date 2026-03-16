/**
 * Deployment manifest — DynamoDB operations for tracking what's deployed where.
 *
 * Table: as-deployments-{stage}
 * PK: ENV#{system}#{stage}#{env_name}
 * SK: COMPONENT#{service} (current state) or DEPLOY#{timestamp}#{service} (history)
 */

import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { fromSSO } from "@aws-sdk/credential-provider-sso";

export type ComponentRecord = {
  service: string;
  artifactSha: string;
  artifactUri: string;
  previousSha: string | null;
  deployedAt: string;
  deployedBy: string;
  version: number;
};

export type DeployHistoryRecord = {
  service: string;
  artifactSha: string;
  artifactUri: string;
  previousSha: string | null;
  deployedBy: string;
  status: "succeeded" | "failed" | "rolling-back";
  deployedAt: string;
};

export type EnvironmentSummary = {
  envName: string;
  componentCount: number;
  lastDeployedAt: string;
};

function envPk(system: string, stage: string, envName: string): string {
  return `ENV#${system}#${stage}#${envName}`;
}

function componentSk(service: string): string {
  return `COMPONENT#${service}`;
}

function deploySk(timestamp: string, service: string): string {
  return `DEPLOY#${timestamp}#${service}`;
}

export class Manifest {
  private client: DynamoDBClient;
  private tableName: string;
  private system: string;

  constructor(tableName: string, region: string, system: string, profile?: string) {
    this.client = new DynamoDBClient({
      region,
      ...(profile ? { credentials: fromSSO({ profile }) } : {}),
    });
    this.tableName = tableName;
    this.system = system;
  }

  async deploy(
    stage: string,
    envName: string,
    service: string,
    artifactSha: string,
    artifactUri: string,
    deployedBy: string,
    expectedVersion: number | null,
  ): Promise<void> {
    const pk = envPk(this.system, stage, envName);
    const now = new Date().toISOString();

    const current = await this.getComponent(stage, envName, service);
    const previousSha = current?.artifactSha ?? null;

    const command = new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: this.tableName,
            Key: marshall({ pk, sk: componentSk(service) }),
            UpdateExpression:
              "SET artifact_sha = :sha, artifact_uri = :uri, previous_sha = :prev, deployed_at = :ts, deployed_by = :actor, version = if_not_exists(version, :zero) + :one, service = :svc",
            ConditionExpression:
              expectedVersion === null
                ? "attribute_not_exists(pk)"
                : "version = :expected",
            ExpressionAttributeValues: marshall({
              ":sha": artifactSha,
              ":uri": artifactUri,
              ":prev": previousSha ?? "NONE",
              ":ts": now,
              ":actor": deployedBy,
              ":zero": 0,
              ":one": 1,
              ":svc": service,
              ...(expectedVersion !== null ? { ":expected": expectedVersion } : {}),
            }),
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: marshall({
              pk,
              sk: deploySk(now, service),
              service,
              artifact_sha: artifactSha,
              artifact_uri: artifactUri,
              previous_sha: previousSha ?? "NONE",
              deployed_by: deployedBy,
              status: "succeeded",
              deployed_at: now,
            }),
          },
        },
      ],
    });

    await this.client.send(command);
  }

  async getComponent(
    stage: string,
    envName: string,
    service: string,
  ): Promise<ComponentRecord | null> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":sk": componentSk(service),
      }),
    });

    const result = await this.client.send(command);
    if (!result.Items || result.Items.length === 0) return null;

    const item = unmarshall(result.Items[0]);
    return {
      service: item.service,
      artifactSha: item.artifact_sha,
      artifactUri: item.artifact_uri,
      previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
      deployedAt: item.deployed_at,
      deployedBy: item.deployed_by,
      version: item.version,
    };
  }

  async listComponents(stage: string, envName: string): Promise<ComponentRecord[]> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":prefix": "COMPONENT#",
      }),
    });

    const result = await this.client.send(command);
    return (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw);
      return {
        service: item.service,
        artifactSha: item.artifact_sha,
        artifactUri: item.artifact_uri,
        previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
        deployedAt: item.deployed_at,
        deployedBy: item.deployed_by,
        version: item.version,
      };
    });
  }

  async listEnvironments(stage: string): Promise<EnvironmentSummary[]> {
    const prefix = `ENV#${this.system}#${stage}#`;

    // Scan with filter — fine for low-volume deployments table
    const envs = new Map<string, { count: number; lastDeployedAt: string }>();
    let lastKey: Record<string, unknown> | undefined;

    do {
      const command = new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "begins_with(pk, :prefix) AND begins_with(sk, :comp)",
        ExpressionAttributeValues: marshall({
          ":prefix": prefix,
          ":comp": "COMPONENT#",
        }),
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      });

      const result = await this.client.send(command);
      for (const raw of result.Items ?? []) {
        const item = unmarshall(raw);
        const pk = item.pk as string;
        const envName = pk.replace(prefix, "");
        const deployedAt = item.deployed_at as string;

        const existing = envs.get(envName);
        if (!existing) {
          envs.set(envName, { count: 1, lastDeployedAt: deployedAt });
        } else {
          existing.count++;
          if (deployedAt > existing.lastDeployedAt) {
            existing.lastDeployedAt = deployedAt;
          }
        }
      }
      lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
    } while (lastKey);

    return Array.from(envs.entries())
      .map(([envName, data]) => ({
        envName,
        componentCount: data.count,
        lastDeployedAt: data.lastDeployedAt,
      }))
      .sort((a, b) => a.envName.localeCompare(b.envName));
  }

  async getHistory(
    stage: string,
    envName: string,
    service?: string,
    limit = 10,
  ): Promise<DeployHistoryRecord[]> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":prefix": "DEPLOY#",
      }),
      ScanIndexForward: false,
      Limit: limit,
    });

    const result = await this.client.send(command);
    const items = (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw);
      return {
        service: item.service,
        artifactSha: item.artifact_sha,
        artifactUri: item.artifact_uri,
        previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
        deployedBy: item.deployed_by,
        status: item.status as DeployHistoryRecord["status"],
        deployedAt: item.deployed_at,
      };
    });

    return service ? items.filter((i) => i.service === service) : items;
  }

  async deleteEnvironment(stage: string, envName: string): Promise<void> {
    const pk = envPk(this.system, stage, envName);

    const allItems: Array<{ pk: string; sk: string }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const command = new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({ ":pk": pk }),
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      });

      const result = await this.client.send(command);
      for (const raw of result.Items ?? []) {
        const item = unmarshall(raw) as { pk: string; sk: string };
        allItems.push(item);
      }
      lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
    } while (lastKey);

    for (let i = 0; i < allItems.length; i += 25) {
      const batch = allItems.slice(i, i + 25);
      const command = new BatchWriteItemCommand({
        RequestItems: {
          [this.tableName]: batch.map((item) => ({
            DeleteRequest: { Key: marshall({ pk: item.pk, sk: item.sk }) },
          })),
        },
      });
      await this.client.send(command);
    }
  }
}
