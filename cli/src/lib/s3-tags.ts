/**
 * S3 object tagging for artifact lifecycle tracking.
 *
 * Tags mirror the artifact promotion state:
 *   status=dev → built and published
 *   status=staging → passed E2E, eligible for prod
 *   status=rejected → failed E2E, blocked
 *   status=prod → deployed to production
 */

import {
  S3Client,
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { fromSSO } from "@aws-sdk/credential-provider-sso";

export type ArtifactS3Tags = {
  status: "dev" | "staging" | "rejected" | "prod";
  builtBy?: string;
};

export async function setArtifactS3Tags(
  bucket: string,
  key: string,
  tags: ArtifactS3Tags,
  region: string,
  profile?: string,
): Promise<void> {
  const client = new S3Client({
    region,
    ...(profile ? { credentials: fromSSO({ profile }) } : {}),
  });

  const tagSet: { Key: string; Value: string }[] = [{ Key: "status", Value: tags.status }];
  if (tags.builtBy) {
    tagSet.push({ Key: "built-by", Value: tags.builtBy });
  }

  await client.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      Tagging: { TagSet: tagSet },
    }),
  );
}

export async function getArtifactS3Tags(
  bucket: string,
  key: string,
  region: string,
  profile?: string,
): Promise<ArtifactS3Tags | null> {
  const client = new S3Client({
    region,
    ...(profile ? { credentials: fromSSO({ profile }) } : {}),
  });

  try {
    const result = await client.send(
      new GetObjectTaggingCommand({ Bucket: bucket, Key: key }),
    );
    const tags = result.TagSet ?? [];
    const status = tags.find((t) => t.Key === "status")?.Value;
    const builtBy = tags.find((t) => t.Key === "built-by")?.Value;
    if (!status) return null;
    return { status: status as ArtifactS3Tags["status"], builtBy };
  } catch {
    return null;
  }
}
