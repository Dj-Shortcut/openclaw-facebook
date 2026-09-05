import { pathToFileURL } from "node:url";

import {
  readFacebookPageTokenRotationEnv,
  rotateFacebookPageToken,
} from "../_core/facebookPageTokenRotation";
import { closeDatabasePool } from "../db";

export async function runFacebookPageTokenRotationCli(): Promise<void> {
  try {
    const input = readFacebookPageTokenRotationEnv();
    const result = await rotateFacebookPageToken(input);
    process.stdout.write(
      `${JSON.stringify({
        event: "facebook_page_token_rotated",
        workspaceId: result.workspaceId,
        channelConnectionId: result.channelConnectionId,
        bindingEpoch: result.bindingEpoch,
        status: result.status,
      })}\n`
    );
  } finally {
    delete process.env.FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN;
    await closeDatabasePool();
  }
}

const scriptUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (scriptUrl === import.meta.url) {
  void runFacebookPageTokenRotationCli().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "facebook_page_token_rotation_failed",
        error: error instanceof Error ? error.name : "UnknownError",
      })}\n`
    );
    process.exitCode = 1;
  });
}
