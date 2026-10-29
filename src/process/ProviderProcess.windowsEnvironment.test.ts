import { expect, it } from "vitest";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

it("retains the Windows system root with a minimal explicit host environment", async () => {
  if (process.platform !== "win32") return;
  const child = await spawnOwnedProviderProcess({
    command: process.execPath,
    arguments: ["-e", "process.stdout.write(process.env.SystemRoot ?? '')"],
    runId: crypto.randomUUID(),
    cwd: process.cwd(),
    hostEnvironment: { PATH: process.env.PATH ?? "" },
  });
  let stdout = "";
  child.process.stdout?.setEncoding("utf8");
  child.process.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  await new Promise<void>((resolve) => child.process.once("close", () => resolve()));
  expect(stdout).toBe(process.env.SystemRoot);
  expect((await child.cleanup()).cleaned).toBe(true);
});
