import { pathToFileURL } from "node:url";

import {
  readFacebookPageTokenRotationEnv,
  rotateFacebookPageToken,
} from "../_core/facebookPageTokenRotation";
import { closeDatabasePool } from "../db";

export async function runFacebookPageTokenRotationCli(): Promise<void> {
  let rotationCommitted = false;
  try {
    const input = readFacebookPageTokenRotationEnv();
    const result = await rotateFacebookPageToken(input);
    rotationCommitted = true;
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
    try {
      await closeDatabasePool();
    } catch {
      // Closing the pool cannot undo a committed rotation or replace an
      // earlier refusal. Report cleanup separately without credential details.
      process.stderr.write(
        `${JSON.stringify({
          event: "facebook_page_token_rotation_cleanup_failed",
          reason: "database_pool_close_failed",
          rotationCommitted,
        })}\n`
      );
      process.exitCode = 1;
    }
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
