import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registeredRoots } from "../../support/cli/configIsolation.js";

let completedRoot: string | undefined;

cliTest(
  "keeps one test's root trusted across repeated CLI calls, then clears it",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-cli-owned-roots-lifecycle-",
    );
    completedRoot = root;
    const environment = {
      HOME: "",
      USERPROFILE: root,
      DSH_HOME: join(root, ".dsh"),
      DSH_AGENTS_HOME: join(root, ".agents"),
    };

    for (let call = 0; call < 2; call += 1) {
      expect(registeredRoots()).toContain(root);
      const result = await cli.run({
        arguments: ["uninstall", "--json"],
        cwd: root,
        environment,
      });
      expect(result.exitCode).toEqual(expect.any(Number));
    }
  },
);

it("does not inherit a completed cliTest root", () => {
  expect(completedRoot).toBeDefined();
  expect(registeredRoots()).not.toContain(completedRoot);
});
