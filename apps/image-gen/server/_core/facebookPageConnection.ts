import * as db from "../db";
import {
  REQUIRED_FACEBOOK_SCOPES,
  sealFacebookPageToken,
  type FacebookConnectPage,
} from "./facebookConnectStore";

export async function connectAuthorizedFacebookPage(input: {
  workspaceId: number;
  userId: number;
  page: FacebookConnectPage;
  source: "facebook_login" | "customer_app";
}) {
  const hasAllScopes = REQUIRED_FACEBOOK_SCOPES.every(scope =>
    input.page.grantedScopes.includes(scope)
  );
  const status = hasAllScopes ? "connected" : "missing_permissions";

  await db.upsertChannelConnection(
    {
      workspaceId: input.workspaceId,
      channel: "facebook_messenger",
      status,
      externalId: input.page.id,
      displayName: input.page.name,
      grantedScopes: input.page.grantedScopes,
      encryptedAccessToken: sealFacebookPageToken(input.page.accessToken),
      lastCheckedAt: new Date(),
    },
    { updatePolicy: "preserve_exact_facebook_page_binding" }
  );
  await db.insertAuditLog({
    workspaceId: input.workspaceId,
    userId: input.userId,
    event: "facebook_page.selected",
    metadata: {
      pageId: input.page.id,
      pageName: input.page.name,
      status,
      source: input.source,
    },
  });

  return { status } as const;
}
