/**
 * ascli artifact <service> --stage <stage>
 *
 * Convenience command: build + publish in one step.
 */

import { buildCommand } from "./build.js";
import { publishCommand, type PublishResult } from "./publish.js";

export type ArtifactOptions = {
  service: string;
  stage: string;
  platform?: string;
  dirty?: boolean;
};

export async function artifactCommand(opts: ArtifactOptions): Promise<PublishResult> {
  const result = buildCommand({ service: opts.service, platform: opts.platform, dirty: opts.dirty });
  return publishCommand({ service: opts.service, stage: opts.stage, sha: result.sha, dirty: opts.dirty });
}
