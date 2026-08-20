import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceRuntimePolicy,
  resolveWorkspaceRuntimePolicyWithDeps,
  resolvePremiumMediaAccessWithDeps,
  WorkspaceEntitlementConfigurationError,
  WorkspaceEntitlementLookupError,
} from "./_core/workspaceEntitlementRuntime";

const originalNodeEnv = process.env.NODE_ENV;
const originalMollieMode = process.env.MOLLIE_MODE;
const originalEntitlementEnforcement =
  process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.MOLLIE_MODE = "test";
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalMollieMode === undefined) delete process.env.MOLLIE_MODE;
  else process.env.MOLLIE_MODE = originalMollieMode;
  if (originalEntitlementEnforcement === undefined)
    delete process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED;
  else
    process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED =
      originalEntitlementEnforcement;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function deps(input?: {
  workspaceIds?: number[];
  planCode?: string;
  quota?: unknown;
  entitlementError?: Error;
}) {
  return {
    findWorkspaceIdsByFacebookPage: async () => input?.workspaceIds ?? [42],
    findActiveEntitlement: async (
      workspaceId: number,
      mode: "test" | "live"
    ) => {
      if (input?.entitlementError) throw input.entitlementError;
      return {
        id: 7,
        workspaceId,
        mode,
        planCode: input?.planCode ?? "startpilot_once_v1",
        quota: input?.quota ?? {
          aiAnswersTotal: 300,
          imagesTotal: 20,
          imagesPerDay: 5,
          workspaces: 1,
          facebookPages: 1,
          imageQuality: "images_2",
        },
      };
    },
  };
}

describe("workspace entitlement runtime policy", () => {
  it("derives the Premium video quota from the server-owned catalog", async () => {
    await expect(
      resolvePremiumMediaAccessWithDeps(
        "page-premium",
        deps({ planCode: "premium_monthly_v1" })
      )
    ).resolves.toEqual({
      workspaceId: 42,
      entitlementId: 7,
      mode: "test",
      videoGenerationsPerDay: 10,
    });
  });

  it("does not add a database dependency before entitlement enforcement is enabled", async () => {
    process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED = "false";
    process.env.DATABASE_URL = "mysql://configured-but-not-contacted";

    await expect(resolveWorkspaceRuntimePolicy("page-1")).resolves.toEqual({
      kind: "free",
    });
  });

  it("keeps legacy free behavior when no Page or workspace binding exists", async () => {
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(undefined, deps())
    ).resolves.toEqual({ kind: "free" });
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ workspaceIds: [] })
      )
    ).resolves.toEqual({ kind: "free" });
  });

  it("resolves one Facebook Page to one Startpilot workspace", async () => {
    process.env.NODE_ENV = "test";
    process.env.MOLLIE_MODE = "test";

    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(" page-1 ", deps())
    ).resolves.toEqual({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 7,
      mode: "test",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
  });

  it("uses MOLLIE_MODE=test even in a production process", async () => {
    process.env.NODE_ENV = "production";
    process.env.MOLLIE_MODE = "test";
    let observedMode: string | undefined;

    const policy = await resolveWorkspaceRuntimePolicyWithDeps("page-1", {
      findWorkspaceIdsByFacebookPage: async () => [42],
      findActiveEntitlement: async (workspaceId, mode) => {
        observedMode = mode;
        return {
          id: 7,
          workspaceId,
          mode,
          planCode: "startpilot_once_v1",
          quota: {
            aiAnswersTotal: 300,
            imagesTotal: 20,
            imagesPerDay: 5,
            workspaces: 1,
            facebookPages: 1,
            imageQuality: "images_2",
          },
        };
      },
    });

    expect(observedMode).toBe("test");
    expect(policy).toMatchObject({ kind: "startpilot", mode: "test" });
  });

  it("fails closed when a Page maps to multiple workspaces", async () => {
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ workspaceIds: [42, 84] })
      )
    ).rejects.toBeInstanceOf(WorkspaceEntitlementLookupError);
  });

  it("fails closed when entitlement lookup fails", async () => {
    const driverError = new Error("driver details must stay private");
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ entitlementError: driverError })
      )
    ).rejects.toMatchObject({
      name: "WorkspaceEntitlementLookupError",
      message: "Workspace entitlement lookup failed",
    });
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ entitlementError: driverError })
      )
    ).rejects.not.toHaveProperty("cause");
  });

  it("preserves invalid billing mode as a configuration error", async () => {
    process.env.MOLLIE_MODE = "invalid";

    await expect(
      resolveWorkspaceRuntimePolicyWithDeps("page-1", deps())
    ).rejects.toBeInstanceOf(WorkspaceEntitlementConfigurationError);
  });

  it("rejects malformed paid quota instead of falling back to free", async () => {
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ quota: { imagesTotal: 999, imagesPerDay: 999 } })
      )
    ).rejects.toBeInstanceOf(WorkspaceEntitlementConfigurationError);
  });

  it("fails closed when paid quota exceeds the exact launch catalog", async () => {
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({
          quota: {
            aiAnswersTotal: 300,
            imagesTotal: 999,
            imagesPerDay: 999,
            workspaces: 1,
            facebookPages: 1,
            imageQuality: "images_2",
          },
        })
      )
    ).rejects.toBeInstanceOf(WorkspaceEntitlementConfigurationError);
  });

  it("fails closed for an active paid plan the runtime does not support", async () => {
    await expect(
      resolveWorkspaceRuntimePolicyWithDeps(
        "page-1",
        deps({ planCode: "legacy_monthly" })
      )
    ).rejects.toBeInstanceOf(WorkspaceEntitlementConfigurationError);
  });
});
