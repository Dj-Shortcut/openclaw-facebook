import { createHash } from "node:crypto";
import { isIP } from "node:net";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRuntimeHostProbe,
  classifyRuntimeHostFailure,
  cleanupRuntimeHostProbe,
  normalizeRuntimeDatabaseUrl,
  repairRuntimeDatabaseHost,
} from "./repair-image-gen-runtime-database-host.mjs";

const username = "lbcr_0123456789ab_123456789";
const password = "test%21password";
const binding = {
  machineId: "0123456789abcd",
  privateIp: "fdaa:0:1::2",
  app: "leaderbot-portal-mysql",
  database: "leaderbot",
  principalSha256: createHash("sha256").update(username).digest("hex"),
};
const source = `mysql://${username}:${password}@[${binding.privateIp}]:3306/leaderbot`;
const target = `mysql://${username}:${password}@${binding.machineId}.vm.${binding.app}.internal:3306/leaderbot`;
afterEach(() => vi.unstubAllEnvs());

describe("redacted repair diagnostics", () => {
  it.each([
    ["not authorized", "access_denied"],
    ["Error: Unauthorized", "access_denied"],
    ["permission denied", "access_denied"],
    ["invalid machine config", "config_rejected"],
    ["unknown flag: --example", "config_rejected"],
    ["failed to pull image", "image_unavailable"],
    ["manifest unknown", "image_unavailable"],
    ["unrecognized failure", "failed"],
  ])(
    "classifies %s without exposing subprocess output",
    (message, category) => {
      const error = Object.assign(new Error(source), {
        stderr: Buffer.from(`${message}: ${source}`),
        stdout: target,
        cause: new Error(password),
      });
      expect(classifyRuntimeHostFailure(error, "probe_create")).toBe(
        `runtime_database_host_probe_create_${category}`,
      );
    },
  );

  it("separates a timed-out create from a rejected create", () => {
    expect(
      classifyRuntimeHostFailure(
        { code: "ETIMEDOUT", stderr: source },
        "probe_create",
      ),
    ).toBe("runtime_database_host_probe_create_timeout");
  });

  it.each([
    "probe_inventory",
    "probe_start",
    "probe_verify",
    "secret_read",
    "secret_stage",
  ])(
    "reports only the fixed %s stage even when output contains a credential",
    (stage) => {
      expect(
        classifyRuntimeHostFailure(
          { message: source, stderr: source, stdout: target },
          stage,
        ),
      ).toBe(`runtime_database_host_${stage}_failed`);
    },
  );

  it("retains explicit rejection markers and rejects unrecognized stage names", () => {
    expect(
      classifyRuntimeHostFailure(
        new Error("runtime_database_host_secret_changed"),
        "secret_read",
      ),
    ).toBe("runtime_database_host_secret_changed");
    expect(classifyRuntimeHostFailure(new Error(source), password)).toBe(
      "runtime_database_host_repair_failed",
    );
  });
});

function repairHarness(failure) {
  const sha = "a".repeat(40);
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("EXCLUSIVE_SECRET_WINDOW", "true");
  vi.stubEnv("GITHUB_SHA", sha);
  vi.stubEnv(
    "GITHUB_WORKFLOW_REF",
    "Dj-Shortcut/openclaw-facebook/.github/workflows/repair-image-gen-runtime-database-host.yml@refs/heads/main",
  );
  const image = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"b".repeat(64)}`;
  const baseline = {
    blockingErrors: [],
    reconcilableDrift: [],
    identity: "deploy-123-1",
    expectedImage: "bridge",
    releaseWatermark: "old",
  };
  const manifest = {
    apps: {
      "image-gen": {
        app: "leaderbot-fb-image-gen",
        reviewedImage: image,
        reviewedSourceCommit: sha,
        reviewedArtifactKind: "runtime",
        databaseSchemaPhase: "0018_credit_checkout_reservation",
        reviewedSettledPredecessor: {
          identity: baseline.identity,
          image: "bridge",
        },
        databaseSchemaTransition: {
          state: "runtime_reviewed",
          bridgeImage: "bridge",
          runtimePrincipalSha256: binding.principalSha256,
        },
        databaseRecovery: {
          app: binding.app,
          databaseName: binding.database,
          volumeId: "vol_test",
          region: "ams",
        },
      },
    },
  };
  const calls = [];
  let probe;
  let secretReads = 0;
  let delayedReads = 0;
  const dependencies = {
    manifest,
    verifyCi: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    checkSettled: vi.fn(async () => baseline),
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (command === "git") return args[0] === "status" ? "" : sha;
      if (command === "gh")
        return args[0] === "api"
          ? sha
          : args[0] === "auth"
            ? "test-token"
            : "verified";
      if (command !== "flyctl") throw new Error("unexpected command");
      if (args[0] === "version") return "flyctl v0.4.85 linux";
      if (args[0] === "secrets" && args[1] === "list") {
        secretReads++;
        return JSON.stringify([
          {
            name: "DATABASE_URL",
            status: "Staged",
            digest:
              failure === "secret_changed" && secretReads > 1 ? "new" : "old",
          },
        ]);
      }
      if (args[0] === "secrets" && args[1] === "import") return "staged";
      if (args[0] === "machine" && args[1] === "list") {
        if (args.includes(binding.app))
          return JSON.stringify([
            {
              id: binding.machineId,
              state: "started",
              private_ip: binding.privateIp,
              config: {
                mounts: [{ volume: "vol_test", path: "/var/lib/mysql" }],
              },
            },
          ]);
        if (failure === "delayed_creation" && ++delayedReads <= 3) return "[]";
        if (failure === "unknown_creation") return "[]";
        return JSON.stringify(probe ? [probe] : []);
      }
      if (args[0] === "machine" && args[1] === "run") {
        const name = args[args.indexOf("--name") + 1];
        probe = {
          id: "abcdef12345678",
          name,
          config: {
            image,
            metadata: { leaderbot_database_host_probe: name },
            services: [],
            mounts: [],
            init: { entrypoint: ["/bin/sleep"], cmd: ["600"] },
          },
        };
        if (
          [
            "create_response_lost",
            "delayed_creation",
            "unknown_creation",
          ].includes(failure)
        )
          throw new Error("lost");
        if (failure === "unexpected_service")
          probe.config.services.push({ port: 8080 });
        return "created";
      }
      if (args[0] === "machine" && args[1] === "destroy") {
        probe = undefined;
        return "destroyed";
      }
      if (args[0] === "machine" && args[1] === "wait") return "started";
      if (args[0] === "ssh") {
        if (failure === "probe_failed") throw new Error("failed");
        return target;
      }
      throw new Error("unexpected command");
    },
  };
  return { calls, dependencies };
}

describe("exact staged database hostname repair", () => {
  it("stages only verified URL bytes through stdin and removes the isolated probe", async () => {
    const { calls, dependencies } = repairHarness();
    expect(
      await repairRuntimeDatabaseHost({ stage: true }, dependencies),
    ).toMatchObject({
      staged: true,
      baselineUnchanged: true,
      probeRemoved: true,
    });
    const imports = calls.filter(
      (call) => call.args[0] === "secrets" && call.args[1] === "import",
    );
    expect(imports).toHaveLength(1);
    expect(imports[0].args).toEqual([
      "secrets",
      "import",
      "--app",
      "leaderbot-fb-image-gen",
      "--stage",
    ]);
    expect(imports[0].options.input).toBe(`DATABASE_URL=${target}\n`);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(
      password,
    );
    expect(calls.filter((call) => call.args[1] === "destroy")).toHaveLength(1);
    expect(dependencies.checkSettled).toHaveBeenCalledTimes(2);
  });

  it("does not stage a secret in verification-only mode", async () => {
    const { calls, dependencies } = repairHarness();
    expect(await repairRuntimeDatabaseHost({}, dependencies)).toMatchObject({
      staged: false,
    });
    expect(calls.some((call) => call.args[1] === "import")).toBe(false);
  });

  it.each([
    ["create_response_lost", "probe_create_failed"],
    ["delayed_creation", "probe_create_failed"],
    ["unexpected_service", "probe_config_rejected"],
    ["probe_failed", "probe_verify_failed"],
    ["secret_changed", "secret_changed"],
  ])(
    "refuses %s, removes its probe and never changes the staged secret",
    async (failure, marker) => {
      const { calls, dependencies } = repairHarness(failure);
      await expect(
        repairRuntimeDatabaseHost({ stage: true }, dependencies),
      ).rejects.toThrow(`runtime_database_host_${marker}`);
      expect(calls.some((call) => call.args[1] === "import")).toBe(false);
      expect(calls.filter((call) => call.args[1] === "destroy")).toHaveLength(
        1,
      );
    },
  );

  it("does not claim cleanup success when a lost creation never becomes visible", async () => {
    const { calls, dependencies } = repairHarness("unknown_creation");
    await expect(
      repairRuntimeDatabaseHost({ stage: true }, dependencies),
    ).rejects.toMatchObject({
      message: "runtime_database_host_probe_create_failed",
      cleanupDiagnostics: ["runtime_database_host_cleanup_incomplete"],
    });
    expect(dependencies.wait).toHaveBeenCalledTimes(24);
    expect(calls.some((call) => call.args[1] === "import")).toBe(false);
    expect(dependencies.checkSettled).toHaveBeenCalledTimes(1);
  });

  it("requires the operator-exclusive window before any probe or secret read", async () => {
    const { calls, dependencies } = repairHarness();
    vi.stubEnv("EXCLUSIVE_SECRET_WINDOW", "false");
    await expect(
      repairRuntimeDatabaseHost({ stage: true }, dependencies),
    ).rejects.toThrow("transition_rejected");
    expect(calls).toHaveLength(0);
  });

  it("preserves the primary category with redacted cleanup diagnostics", async () => {
    const { dependencies } = repairHarness("secret_changed");
    const execute = dependencies.execute;
    dependencies.execute = (command, args, options) => {
      if (args[1] === "destroy") throw new Error(`sensitive ${password}`);
      return execute(command, args, options);
    };
    const error = await repairRuntimeDatabaseHost(
      { stage: true },
      dependencies,
    ).catch((error) => error);
    expect(error.message).toBe("runtime_database_host_secret_changed");
    expect(error.cleanupDiagnostics).toEqual([
      "runtime_database_host_cleanup_destroy_failed",
      "runtime_database_host_cleanup_incomplete",
    ]);
    expect(JSON.stringify(error)).not.toContain(password);
    expect(error.cause).toBeUndefined();
    expect(dependencies.checkSettled).toHaveBeenCalledTimes(1);
  });

  it("continues safe cleanup past rejected rows and still performs the final list", async () => {
    const name = "dbhost-test";
    let safeExists = true;
    let lists = 0;
    const destroyed = [];
    const diagnostics = await cleanupRuntimeHostProbe({
      name,
      wait: async () => {},
      runFly(args) {
        if (args[1] === "list") {
          lists++;
          return JSON.stringify([
            { name, id: "unsafe", config: {} },
            ...(safeExists
              ? [
                  {
                    name,
                    id: "abcdef12345678",
                    config: {
                      metadata: { leaderbot_database_host_probe: name },
                    },
                  },
                ]
              : []),
          ]);
        }
        destroyed.push(args[2]);
        safeExists = false;
        return "destroyed";
      },
    });
    expect(destroyed).toEqual(["abcdef12345678"]);
    expect(lists).toBe(26);
    expect(diagnostics).toEqual([
      "runtime_database_host_cleanup_rejected",
      "runtime_database_host_cleanup_incomplete",
    ]);
  });

  it("reports a cleanup failure when the primary operation succeeded", async () => {
    const { dependencies } = repairHarness();
    const execute = dependencies.execute;
    dependencies.execute = (command, args, options) => {
      if (args[1] === "destroy") throw new Error("destroy failed");
      return execute(command, args, options);
    };
    await expect(
      repairRuntimeDatabaseHost({}, dependencies),
    ).rejects.toMatchObject({
      message: "runtime_database_host_cleanup_destroy_failed",
    });
    expect(dependencies.checkSettled).toHaveBeenCalledTimes(1);
  });

  it("refuses execution outside the protected workflow before reading any secret", async () => {
    const { calls, dependencies } = repairHarness();
    vi.stubEnv("GITHUB_ACTIONS", "false");
    await expect(
      repairRuntimeDatabaseHost({ stage: true }, dependencies),
    ).rejects.toThrow("transition_rejected");
    expect(calls).toHaveLength(0);
  });

  it("changes only the hostname and preserves account, password, port and database", () => {
    expect(new URL(source).hostname).toBe(`[${binding.privateIp}]`);
    expect(isIP(new URL(source).hostname)).toBe(0);
    const result = normalizeRuntimeDatabaseUrl(source, binding);
    expect(result).toEqual({
      url: target,
      changed: true,
      host: new URL(target).hostname,
    });
    for (const field of [
      "username",
      "password",
      "port",
      "pathname",
      "protocol",
    ])
      expect(new URL(result.url)[field]).toBe(new URL(source)[field]);
  });

  it("recognizes the already repaired URL without changing credentials", () => {
    expect(normalizeRuntimeDatabaseUrl(target, binding)).toMatchObject({
      url: target,
      changed: false,
    });
  });

  it.each([
    source.replace(binding.privateIp, "fdaa:0:1::3"),
    source.replace(`[${binding.privateIp}]`, "127.0.0.1"),
    source.replace(username, "lbcr_other"),
    source.replace(":3306", ":3307"),
    source.replace("/leaderbot", "/other"),
    `${source}?host=attacker.example`,
    `${source}#fragment`,
    "not a URL",
  ])("rejects unbound input without exposing credential material", (value) => {
    let error;
    try {
      normalizeRuntimeDatabaseUrl(value, binding);
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe("runtime_database_host_rejected");
    expect(error?.stack).not.toContain(username);
    expect(error?.stack).not.toContain(password);
    expect(error?.cause).toBeUndefined();
  });

  it.each(["machineId", "privateIp", "app", "database", "principalSha256"])(
    "rejects a changed %s binding",
    (field) => {
      expect(() =>
        normalizeRuntimeDatabaseUrl(source, { ...binding, [field]: "wrong" }),
      ).toThrow("runtime_database_host_rejected");
    },
  );

  it.each(["success", "dns_mismatch", "schema_failed", "trigger_failed"])(
    "runs the actual serialized isolated probe: %s",
    async (outcome) => {
      const calls = [];
      let stdout = "";
      let stderr = "";
      const process = {
        env: { DATABASE_URL: source },
        execPath: "/node",
        stdout: {
          write: (value) => {
            stdout += value;
          },
        },
        stderr: {
          write: (value) => {
            stderr += value;
          },
        },
        exitCode: undefined,
      };
      const context = {
        URL,
        process,
        require(name) {
          if (name === "node:crypto") return { createHash };
          if (name === "node:net") return { isIP };
          if (name === "node:dns/promises")
            return {
              resolve6: async () => [
                outcome === "dns_mismatch" ? "fdaa::9" : binding.privateIp,
              ],
            };
          if (name === "node:child_process")
            return {
              spawnSync(command, args, options) {
                calls.push({ command, args, options });
                return {
                  status:
                    (outcome === "schema_failed" && calls.length === 1) ||
                    (outcome === "trigger_failed" && calls.length === 2)
                      ? 1
                      : 0,
                };
              },
            };
          throw new Error("unexpected dependency");
        },
      };
      await vm.runInNewContext(buildRuntimeHostProbe(binding), context);
      for (const call of calls) {
        expect(call.options.env.DATABASE_URL).toBe(target);
        expect(call.options.env.LEADERBOT_PRODUCTION_MIGRATION_MODE).toBe(
          "verify-artifact",
        );
        expect(call.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      }
      if (outcome === "success") {
        expect(calls.map((call) => call.args)).toEqual([
          ["/app/dist/migrate-production.cjs"],
          ["/app/dist/billing-trigger-runtime-preflight.cjs"],
        ]);
        expect(stdout).toBe(target);
        expect(stderr).toBe("");
      } else {
        expect(stdout).toBe("");
        expect(stderr).toBe("runtime_database_host_probe_failed\n");
        expect(process.exitCode).toBe(1);
      }
    },
  );
});
