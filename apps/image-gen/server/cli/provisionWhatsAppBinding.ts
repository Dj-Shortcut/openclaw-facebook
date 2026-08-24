import { pathToFileURL } from "node:url";
import {
  provisionWhatsAppTenantBinding,
  readWhatsAppProvisioningEnv,
} from "../_core/whatsappProvisioning";

export async function runWhatsAppProvisioningCli(): Promise<void> {
  const result = await provisionWhatsAppTenantBinding(
    readWhatsAppProvisioningEnv()
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "whatsapp_binding_provisioned",
      workspaceId: result.workspaceId,
      status: result.status,
    })}\n`
  );
}

const scriptUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (scriptUrl === import.meta.url) {
  void runWhatsAppProvisioningCli().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "whatsapp_binding_provision_failed",
        error: error instanceof Error ? error.name : "UnknownError",
      })}\n`
    );
    process.exitCode = 1;
  });
}
