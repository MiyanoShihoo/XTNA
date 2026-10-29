import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const versionedDocumentation = ["docs/installation.md"] as const;

describe("release configuration", () => {
  it("keeps doctor and setup runtime support aligned with package engines", async () => {
    expect(await readJson("package.json")).toMatchObject({
      engines: { node: SUPPORTED_NODE_VERSION_RANGE },
    });
  });

  it("updates every package-version artifact in release PRs", async () => {
    const configuration = await readJson("release-please-config.json");

    expect(configuration).toMatchObject({
      versioning: "always-bump-minor",
      packages: {
        ".": {
          "package-name": "xtna",
          "extra-files": [
            ...versionedDocumentation.map((path) => ({
              type: "generic",
              path,
            })),
            {
              type: "generic",
              path: "src/generatedPackageMetadata.ts",
            },
          ],
        },
      },
    });
  });

  it.each(versionedDocumentation)(
    "marks the versioned package example in %s",
    async (path) => {
      const content = await readFile(path, "utf8");
      const packageJson = (await readJson("package.json")) as {
        version: string;
      };
      const versionBlock =
        /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/u.exec(
          content,
        )?.[0];

      expect(versionBlock).toContain(`xtna@${packageJson.version}`);
    },
  );

  it("keeps the release baseline, lockfile, and changelog aligned with the package version", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    expect(await readJson(".release-please-manifest.json")).toEqual({
      ".": packageJson.version,
    });
    expect(await readJson("package-lock.json")).toMatchObject({
      version: packageJson.version,
      packages: { "": { version: packageJson.version } },
    });
    const changelog = await readFile("CHANGELOG.md", "utf8");
    expect(/^## \[([^\]]+)\]/mu.exec(changelog)?.[1]).toBe(packageJson.version);
  });

  it("keeps the XTNA package identity separate from upstream REA registry provenance", async () => {
    const packageJson = (await readJson("package.json")) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const serverJson = (await readJson("server.json")) as {
      name: string;
      version: string;
      repository: { url: string; source: string };
      packages: Array<{
        registryType: string;
        registryBaseUrl: string;
        identifier: string;
        version: string;
        runtimeHint: string;
        transport: { type: string };
        packageArguments: Array<{ type: string; value: string }>;
      }>;
    };

    expect(packageJson).toMatchObject({
      name: "xtna",
      mcpName: "io.github.xtna/xtna",
    });
    expect(serverJson).toEqual({
      $schema:
        "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "io.github.morluto/rea",
      title: "REA",
      description:
        "Reverse engineer anything from your terminal or agent with one CLI and MCP server.",
      websiteUrl: "https://github.com/morluto/rea",
      repository: {
        url: "https://github.com/morluto/rea",
        source: "github",
      },
      version: "6.8.0",
      packages: [
        {
          registryType: "npm",
          registryBaseUrl: "https://registry.npmjs.org",
          identifier: "rea-agents",
          version: "6.8.0",
          runtimeHint: "npx",
          transport: { type: "stdio" },
          packageArguments: [{ type: "positional", value: "mcp" }],
        },
      ],
    });
  });
});
