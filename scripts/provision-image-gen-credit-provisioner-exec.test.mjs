import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPrepareRootExecArgv,
  listManagedProvisionerAccountsViaExec,
  parsePrepareRootExecResponse,
  PREPARE_DEADLINE_MS,
  PREPARE_ROOT_EXEC_COMMAND,
  PREPARE_ROOT_EXEC_COMMAND_FLYCTL_CSV,
  RESTRICTED_EXEC_OPERATIONS,
  RESTRICTED_EXEC_SECRET,
  requestPrepareRootExec,
} from "./provision-image-gen-credit-provisioner-exec.mjs";
import { SUPER_CLEANUP_EXEC_COMMAND } from "./image-gen-super-cleanup-exec.mjs";

const TARGET = Object.freeze({
  app: "leaderbot-portal-mysql",
  machineId: "e82340db573078",
});
const TOKEN = "fly-token";

function response(body, { status = 200, url } = {}) {
  const payload = JSON.stringify(body);
  return {
    status,
    redirected: false,
    url:
      url ??
      `https://api.machines.dev/v1/apps/leaderbot-portal-mysql/machines/${TARGET.machineId}/exec`,
    headers: new Headers({
      "content-length": String(Buffer.byteLength(payload)),
    }),
    body: new Response(payload).body,
  };
}

const ok = (stdout = "") =>
  response({ exit_code: 0, exit_signal: 0, stdout, stderr: "" });

describe("prepare root exec command", () => {
  it("cannot be run by a credential scoped to the cleanup wrapper", () => {
    expect(PREPARE_ROOT_EXEC_COMMAND).not.toBe(SUPER_CLEANUP_EXEC_COMMAND);
    expect(PREPARE_ROOT_EXEC_COMMAND).toContain("leaderbot-prepare-root");
    expect(SUPER_CLEANUP_EXEC_COMMAND).not.toContain("leaderbot-prepare-root");
  });

  it("encodes the flyctl CSV field by doubling quotes only", () => {
    expect(PREPARE_ROOT_EXEC_COMMAND_FLYCTL_CSV).toBe(
      `"${PREPARE_ROOT_EXEC_COMMAND.replaceAll('"', '""')}"`,
    );
  });

  it.each([
    ["a non-string", 1],
    ["an empty string", ""],
    ["whitespace only", "   \n"],
    ["an embedded NUL", "SELECT 1\0"],
    ["an oversized batch", `SELECT ${"1".repeat(16_385)}`],
  ])("refuses %s", (_label, sql) => {
    expect(() => buildPrepareRootExecArgv(sql)).toThrow();
  });

  it("puts SQL in exactly one argument that is never shell source", () => {
    const sql = "SELECT 'quoted', \"double\", '$HOME', '`exit 92`';\nDO 0;";
    const argv = buildPrepareRootExecArgv(sql);

    expect(argv).toHaveLength(5);
    expect(argv[4]).toBe(sql);
    expect(argv.slice(0, 4)).toEqual([
      "/bin/sh",
      "-lc",
      expect.stringContaining('test "$#" -eq 1 || exit 64'),
      "leaderbot-prepare-root",
    ]);
    expect(Object.isFrozen(argv)).toBe(true);
  });

  it("rejects a second argument on the Machine, not in the caller", () => {
    // Isolate quoting from host login-profile initialization; the production
    // login shell still requires the separate isolated Fly proof.
    const source = buildPrepareRootExecArgv("DO 0;")[2].replace(
      /exec env .*$/,
      'printf "%s" "$1"',
    );
    expect(
      execFileSync(
        "/bin/sh",
        ["-c", source, "leaderbot-prepare-root", "DO 0;"],
        {
          encoding: "utf8",
        },
      ),
    ).toBe("DO 0;");
    const extra = (() => {
      try {
        execFileSync(
          "/bin/sh",
          [
            "-c",
            source,
            "leaderbot-prepare-root",
            "DO 0;",
            "DROP DATABASE leaderbot",
          ],
          { stdio: "pipe" },
        );
      } catch (error) {
        return error;
      }
    })();
    expect(extra?.status).toBe(64);
    expect(extra?.stdout.toString()).toBe("");
  });
});

describe("prepare root exec response", () => {
  it.each([
    ["a missing exit code", { stdout: "", stderr: "" }],
    ["a non-zero exit code", { exit_code: 64, stdout: "", stderr: "" }],
    [
      "a non-zero signal",
      { exit_code: 0, exit_signal: 9, stdout: "", stderr: "" },
    ],
    ["any stderr", { exit_code: 0, stdout: "", stderr: "warning" }],
    ["a non-string stdout", { exit_code: 0, stdout: null, stderr: "" }],
    ["a non-object", "1"],
  ])("refuses %s", (_label, value) => {
    expect(() => parsePrepareRootExecResponse(value)).toThrow();
  });

  it("accepts an absent signal field with a zero exit code", () => {
    expect(
      parsePrepareRootExecResponse({ exit_code: 0, stdout: "1", stderr: "" }),
    ).toBe("1");
  });
});

describe("prepare root exec request", () => {
  afterEach(() => vi.restoreAllMocks());

  const input = (sql = "SELECT 1") => ({
    ...TARGET,
    sql,
    signal: new AbortController().signal,
  });

  it("sends one argument array to the exact machine URL", async () => {
    const fetchImpl = vi.fn(async () => ok("1\n"));
    await expect(
      requestPrepareRootExec(input(), { fetchImpl, token: TOKEN }),
    ).resolves.toBe("1\n");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.machines.dev/v1/apps/leaderbot-portal-mysql/machines/${TARGET.machineId}/exec`,
    );
    expect(init.redirect).toBe("error");
    const body = JSON.parse(init.body);
    expect(body.command).toEqual([...buildPrepareRootExecArgv("SELECT 1")]);
    expect(body).not.toHaveProperty("cmd");
    expect(body).not.toHaveProperty("stdin");
  });

  it.each([
    ["a foreign app", { app: "leaderbot-other" }],
    ["a malformed machine id", { machineId: "nope" }],
  ])("refuses %s before any request", async (_label, override) => {
    const fetchImpl = vi.fn(async () => ok());
    await expect(
      requestPrepareRootExec(
        { ...input(), ...override },
        { fetchImpl, token: TOKEN },
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a missing token before any request", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await expect(
      requestPrepareRootExec(input(), { fetchImpl, token: "  " }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, AbortSignal.abort()])(
    "refuses a missing, invalid or aborted signal before dispatch",
    async (signal) => {
      const fetchImpl = vi.fn(async () => ok());
      await expect(
        requestPrepareRootExec(
          { ...input(), signal },
          { fetchImpl, token: TOKEN },
        ),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["headers", "body"])(
    "enforces its own deadline while awaiting %s",
    async (stage) => {
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(deadline.signal);
      const fetchImpl = vi.fn(async (_url, { signal }) => {
        if (stage === "headers") {
          return await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            queueMicrotask(() => deadline.abort());
          });
        }
        return {
          ...ok(),
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
              queueMicrotask(() => deadline.abort());
            },
          }),
        };
      });
      await expect(
        requestPrepareRootExec(input(), { fetchImpl, token: TOKEN }),
      ).rejects.toThrow();
      expect(timeout).toHaveBeenCalledWith(PREPARE_DEADLINE_MS);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("keeps caller cancellation active without retrying", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      expect(signal).not.toBe(caller.signal);
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        queueMicrotask(() => caller.abort());
      });
    });
    await expect(
      requestPrepareRootExec(
        { ...input(), signal: caller.signal },
        { fetchImpl, token: TOKEN },
      ),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry a rejected transport", async () => {
    const fetchImpl = vi.fn(async () => response({}, { status: 502 }));
    await expect(
      requestPrepareRootExec(input(), { fetchImpl, token: TOKEN }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirected response even with a success body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ...ok("1\n"),
      url: "https://api.machines.dev/elsewhere",
    }));
    await expect(
      requestPrepareRootExec(input(), { fetchImpl, token: TOKEN }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never places the token or SQL in the URL", async () => {
    const fetchImpl = vi.fn(async () => ok("1\n"));
    await requestPrepareRootExec(input("SELECT 'secret-marker'"), {
      fetchImpl,
      token: TOKEN,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("secret-marker");
  });
});

describe("restricted exec credential contract", () => {
  it("keeps one secret and gives each operation its own wrapper", () => {
    const { prepare, revokeSuper } = RESTRICTED_EXEC_OPERATIONS;

    // One short-lived credential carries both prefixes; the existing secret
    // and its retirement flow are unchanged.
    expect(RESTRICTED_EXEC_SECRET).toBe("FLY_DATABASE_REPAIR_EXEC_TOKEN");
    expect(prepare.wrapperArgv0).not.toBe(revokeSuper.wrapperArgv0);
    expect(prepare.operation).toBe("prepare");
    expect(revokeSuper.operation).toBe("revoke-super");
  });

  it("matches the wrapper each command actually runs", () => {
    expect(PREPARE_ROOT_EXEC_COMMAND).toContain(
      RESTRICTED_EXEC_OPERATIONS.prepare.wrapperArgv0,
    );
    expect(SUPER_CLEANUP_EXEC_COMMAND).toContain(
      RESTRICTED_EXEC_OPERATIONS.revokeSuper.wrapperArgv0,
    );
    expect(PREPARE_ROOT_EXEC_COMMAND).not.toContain(
      RESTRICTED_EXEC_OPERATIONS.revokeSuper.wrapperArgv0,
    );
    expect(SUPER_CLEANUP_EXEC_COMMAND).not.toContain(
      RESTRICTED_EXEC_OPERATIONS.prepare.wrapperArgv0,
    );
  });

  it("pins both prefixes to a complete wrapper, never a bare shell", () => {
    for (const command of [
      PREPARE_ROOT_EXEC_COMMAND,
      SUPER_CLEANUP_EXEC_COMMAND,
    ]) {
      expect(command.startsWith("/bin/sh -lc '")).toBe(true);
      expect(command).toContain('test "$#" -eq 1 || exit 64');
      expect(command).toContain("mysql --protocol=socket");
      expect(command.trim()).not.toBe("/bin/sh");
      expect(command.trim()).not.toBe("/bin/sh -lc");
    }
  });

  it("rejects a different shell source under the same prefix", () => {
    const argv = buildPrepareRootExecArgv("DO 0;");
    const tampered = argv[2].replace("mysql --protocol=socket", "sh -c");

    // The shell source is inside the pinned prefix, so any edit produces a
    // command a prefix-scoped credential cannot authorise.
    expect(tampered).not.toBe(argv[2]);
    expect(PREPARE_ROOT_EXEC_COMMAND).toContain(argv[2]);
    expect(PREPARE_ROOT_EXEC_COMMAND).not.toContain(tampered);
    expect(SUPER_CLEANUP_EXEC_COMMAND).not.toContain(tampered);
    // Both wrappers deliberately share the same shell source; only the fixed
    // argv0 separates them, so the two prefixes stay distinct commands.
    expect(PREPARE_ROOT_EXEC_COMMAND).not.toBe(SUPER_CLEANUP_EXEC_COMMAND);
  });
});

describe("transport boundary", () => {
  it("never reaches for a child process or SSH", async () => {
    const source = await readFile(
      new URL(
        "./provision-image-gen-credit-provisioner-exec.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    // Comments explain the retired SSH transport, so match code only.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // The CSV export name mentions flyctl on purpose: it encodes the
    // credential-creation flag, it does not invoke the CLI.
    expect(code).not.toMatch(/child_process/);
    expect(code).not.toMatch(
      /\b(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/,
    );
    expect(code).not.toMatch(/["'`]ssh["'`]|ssh console/);
  });
});

describe("managed account inventory over exec", () => {
  it("parses the inventory without opening an SSH session", async () => {
    const fetchImpl = vi.fn(async () =>
      ok(`lbcp_${"a".repeat(16)}\t%\nlbcp_${"b".repeat(16)}\t%\n`),
    );
    await expect(
      listManagedProvisionerAccountsViaExec(
        { ...TARGET, signal: new AbortController().signal },
        {
          fetchImpl,
          token: TOKEN,
        },
      ),
    ).resolves.toHaveLength(2);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.command[4]).toContain("FROM mysql.user WHERE User LIKE");
  });
});
