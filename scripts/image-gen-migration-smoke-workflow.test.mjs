import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.resolve(
  ".github/workflows/image-gen-migration-smoke.yml",
);

describe("image-gen migration smoke workflow", () => {
  it("cancels stale runs for the same PR or branch", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain(
      "image-gen-migration-smoke-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
  });

  it("verifies the legacy dailyQuota user-only index is absent", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("dailyQuota_userId_date_unique");
    expect(workflow).toContain("dailyQuota_userId_unique");
    expect(workflow).toContain(
      "Legacy unique index dailyQuota_userId_unique must be absent",
    );
    expect(workflow).toContain('if [ "$legacy_index_count" != "0" ]; then');
  });

  it("runs the credit-provisioner retirement contract on the exact MySQL service", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain(
      "Exercise credit-provisioner retirement against MySQL 8.4",
    );
    expect(workflow).toContain('RUN_MYSQL_INTEGRATION: "1"');
    expect(workflow).toContain(
      "pnpm exec vitest run server/creditProvisionerRetirement.mysql.test.ts",
    );
    expect(workflow).toContain(
      "DATABASE_URL: mysql://root:root@127.0.0.1:3306/test_image_gen",
    );
  });
});
