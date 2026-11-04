import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  NPX_REGISTRATION_COMMAND,
  clearClientLocationEnvironment,
} from "../../fixtures/clientEnvironment.js";

import {
  readClientRegistrationInspections,
  readClientRegistrationStatuses,
} from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { classifyClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import { err } from "../../../src/domain/result.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../../../src/process/CurrentEntrypointPath.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("client registration status", () => {
  it("discovers Claude Code from its config file without a marker directory", async () => {
    const home = await createTestTempDirectory("rea-claude-config-only-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          xtna: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, "/current/rea");

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "claude_code",
        config_path: join(home, ".claude.json"),
        state: "aligned",
        remediation: null,
      }),
    ]);
  });

  it("distinguishes aligned, stale, missing, and invalid registrations", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    const currentEntry = join(home, "current-rea.mjs");
    const foreignEntry = join(home, "foreign-rea.mjs");
    await writeFile(currentEntry, "// current dispatcher\n");
    await writeFile(foreignEntry, "// different dispatcher\n");
    await Promise.all([
      mkdir(join(home, ".codex")),
      mkdir(join(home, ".cursor")),
      mkdir(join(home, ".gemini")),
      mkdir(join(home, ".claude")),
    ]);
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.xtna]\ncommand = "npx"\nargs = ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n`,
    );
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          xtna: { command: foreignEntry, args: ["mcp"], env: { SECRET: "x" } },
        },
      }),
    );
    await writeFile(join(home, ".gemini/settings.json"), "not-json");

    const statuses = await readClientRegistrationStatuses(home, currentEntry);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
          remediation: null,
        }),
        expect.objectContaining({
          client: "cursor",
          state: "stale",
          command: [foreignEntry, "mcp"],
          remediation: expect.stringMatching(/\S/u),
        }),
        expect.objectContaining({
          client: "gemini_cli",
          state: "invalid",
          command: [],
          remediation: expect.stringMatching(/\S/u),
        }),
        expect.objectContaining({
          client: "claude_code",
          state: "missing",
          command: [],
          remediation: expect.stringMatching(/\S/u),
        }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain("SECRET");
  });

  it.each([null, [], "invalid"])(
    "reports a malformed server table %j as invalid",
    async (servers) => {
      const home = await createTestTempDirectory("rea-registration-shape-");
      await mkdir(join(home, ".cursor"));
      await writeFile(
        join(home, ".cursor/mcp.json"),
        JSON.stringify({ mcpServers: servers }),
      );
      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "cursor",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );
});

describe("client registration environment validation", () => {
  it("reports an otherwise aligned registration invalid for a bad tool-family scope", async () => {
    const home = await createTestTempDirectory("rea-registration-env-");
    await mkdir(join(home, ".cursor"));
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          xtna: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
            env: { REA_MCP_TOOL_FAMILIES: "session,typo" },
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(home, "/current/rea");

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "cursor",
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("REA_MCP_TOOL_FAMILIES"),
      }),
    ]);
  });

  it("resolves provider budgets only for Kimi/Codex registrations", async () => {
    const home = await createTestTempDirectory("rea-registration-budget-");
    await mkdir(join(home, ".cursor"));
    await mkdir(join(home, ".codex"));
    const entry = {
      command: "npx",
      args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
    };
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { xtna: entry } }),
    );
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.xtna]\ncommand = "npx"\nargs = ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]\n`,
    );
    const resolveProviderRequestBudget = async () =>
      err(new ConfigurationError("budget unavailable"));

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        resolveProviderRequestBudget,
      },
    );

    const byClient = new Map(statuses.map((status) => [status.client, status]));
    // The failing resolver must not invalidate non-Kimi/Codex registrations.
    expect(byClient.get("cursor")?.state).not.toBe("invalid");
    expect(byClient.get("codex")).toMatchObject({
      state: "invalid",
      remediation: expect.stringContaining("budget unavailable"),
    });
  });
});

describe("client registration launcher identity", () => {
  it("reports an unversioned npx registration as stale", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.xtna]\ncommand = "npx"\nargs = ["-y", "rea-agents", "mcp"]\n',
    );

    const statuses = await readClientRegistrationStatuses(home);

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "codex",
        command: ["npx", "-y", "rea-agents", "mcp"],
        state: "stale",
      }),
    ]);
  });

  it("reports an unpinned bunx registration as stale rather than aligned", async () => {
    const home = await createTestTempDirectory("rea-bunx-unpinned-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          xtna: { command: "bunx", args: ["rea-agents", "mcp"] },
        },
      }),
    );

    const [status] = await readClientRegistrationStatuses(home);

    expect(status).toMatchObject({
      client: "claude_code",
      command: ["bunx", "rea-agents", "mcp"],
      state: "stale",
    });
  });

  it("preserves direct command identity as unknown when the current entrypoint is absent", async () => {
    const home = await createTestTempDirectory("rea-registration-unknown-");
    await mkdir(join(home, ".cursor"));
    const command = ["/opt/rea/bin/rea", "mcp"];
    const config = join(home, ".cursor/mcp.json");
    const original = JSON.stringify({
      mcpServers: { xtna: { command: command[0], args: [command[1]] } },
    });
    await writeFile(config, original);

    const [status] = await readClientRegistrationStatuses(home, "");

    expect(status).toMatchObject({
      client: "cursor",
      command,
      state: "unknown",
      config_path: config,
      remediation: expect.stringMatching(/\S/u),
    });
    expect(status).not.toHaveProperty("commandIdentity");
    expect(await readClientRegistrationInspections(home, "")).toEqual([
      expect.objectContaining({
        status,
        activation: "enabled",
        commandIdentity: "unknown",
      }),
    ]);
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("does not use the REA process cwd to resolve a client's relative launcher path", async () => {
    const home = await createTestTempDirectory("rea-registration-relative-");
    await mkdir(join(home, ".cursor"));
    const currentEntry = resolve("./rea.mjs");
    const configPath = join(home, ".cursor/mcp.json");
    const registration = (
      scriptPath: string,
      executable = process.execPath,
    ) => ({
      mcpServers: {
        xtna: { command: executable, args: [scriptPath, "mcp"] },
      },
    });
    await writeFile(configPath, JSON.stringify(registration("./rea.mjs")));

    const [relativeStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(relativeStatus).toMatchObject({
      command: [process.execPath, "./rea.mjs", "mcp"],
      state: "unknown",
    });

    await writeFile(configPath, JSON.stringify(registration(currentEntry)));
    const [absoluteStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(absoluteStatus).toMatchObject({
      command: [process.execPath, currentEntry, "mcp"],
      state: "aligned",
    });

    const relativeInterpreter = relative(process.cwd(), process.execPath);
    await writeFile(
      configPath,
      JSON.stringify(registration(currentEntry, relativeInterpreter)),
    );
    const [relativeInterpreterStatus] = await readClientRegistrationStatuses(
      home,
      currentEntry,
    );
    expect(relativeInterpreterStatus).toMatchObject({
      command: [relativeInterpreter, currentEntry, "mcp"],
      state: "unknown",
    });
  });
});

describe("client registration package version identity", () => {
  it.each([
    ["4.1.0", true],
    ["v4.1.0", false],
  ] as const)(
    "preserves package version %s ownership with canonical-only drift reporting",
    async (version, reportsDrift) => {
      const home = await createTestTempDirectory(
        "rea-registration-version-drift-",
      );
      await mkdir(join(home, ".codex"));
      const reference = `rea-agents@${version}`;
      const command = ["npx", "-y", reference, "mcp"];
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.xtna]\ncommand = "${command[0]}"\nargs = ["${command[1]}", "${command[2]}", "${command[3]}"]\n`,
      );

      const [status] = await readClientRegistrationStatuses(home);

      expect(classifyClientRegistrationCommand(command, undefined)).toBe(
        "owned",
      );
      expect(status).toMatchObject({
        client: "codex",
        command,
        package_reference: reference,
        state: "stale",
      });
      if (reportsDrift) {
        expect(status?.remediation).toContain(
          `current REA CLI package is ${PRODUCT_IDENTITY.packageVersion}`,
        );
        expect(status?.remediation).toContain(
          "does not resolve package-runner",
        );
        expect(status?.remediation).toContain("rea setup --client codex");
      } else {
        expect(status?.remediation).not.toContain("current REA CLI package");
        expect(status?.remediation).not.toContain(
          "does not resolve package-runner",
        );
      }
      expect(status?.remediation).toContain("rea setup");
    },
  );
});

describe("commandcode registration status", () => {
  const writeCommandcodeRegistration = async (
    home: string,
    registration: Record<string, unknown>,
  ): Promise<void> => {
    await mkdir(join(home, ".commandcode"));
    await writeFile(
      join(home, ".commandcode/mcp.json"),
      JSON.stringify({ mcpServers: { xtna: registration } }),
    );
  };

  const ownedArgs = (): readonly string[] => [
    "-y",
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    "mcp",
  ];

  it.each([undefined, "sse"])(
    "reports transport %j as invalid",
    async (transport) => {
      const home = await createTestTempDirectory("rea-commandcode-transport-");
      await writeCommandcodeRegistration(home, {
        ...(transport === undefined ? {} : { transport }),
        command: "npx",
        args: [...ownedArgs()],
      });

      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "commandcode",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );

  it("reports a disabled registration as stale", async () => {
    const home = await createTestTempDirectory("rea-commandcode-disabled-");
    await writeCommandcodeRegistration(home, {
      transport: "stdio",
      enabled: false,
      command: "npx",
      args: [...ownedArgs()],
    });

    expect(await readClientRegistrationStatuses(home)).toEqual([
      expect.objectContaining({
        client: "commandcode",
        state: "stale",
      }),
    ]);
  });
});

describe("client activation keys", () => {
  it.each([
    ["disabled = true", "aligned"],
    ["enabled = false", "stale"],
  ] as const)(
    "reads only the activation key Codex honors (%s)",
    async (activation, state) => {
      const home = await createTestTempDirectory("rea-codex-activation-");
      await mkdir(join(home, ".codex"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.xtna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n${activation}\n`,
      );
      expect(
        await readClientRegistrationStatuses(home, entry, { environment: {} }),
      ).toEqual([expect.objectContaining({ client: "codex", state })]);
    },
  );

  // Each JSON client loads rea under the key it ignores and skips it under the key it honors.
  it.each([
    ["kimi", { disabled: true }, "aligned"],
    ["kimi", { enabled: false }, "stale"],
    ["devin", { enabled: false }, "aligned"],
    ["devin", { disabled: true }, "stale"],
  ] as const)(
    "reads only the activation key %s honors (%j)",
    async (client, activation, state) => {
      const home = await createTestTempDirectory("rea-json-activation-");
      const entry = resolve("scripts/rea.mjs");
      const [config, fields] =
        client === "kimi"
          ? [
              join(home, ".kimi-code/mcp.json"),
              {
                env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
                startupTimeoutMs: 30_000,
                toolTimeoutMs: 450_000,
              },
            ]
          : [
              join(
                process.platform === "win32"
                  ? join(home, "AppData", "Roaming", "devin")
                  : join(home, ".config", "devin"),
                "mcp_config.json",
              ),
              {},
            ];
      await mkdir(dirname(config), { recursive: true });
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: {
            xtna: {
              command: process.execPath,
              args: [entry, "mcp"],
              ...fields,
              ...activation,
            },
          },
        }),
      );
      expect(
        await readClientRegistrationStatuses(home, entry, {
          environment: { XDG_CONFIG_HOME: join(home, ".config") },
        }),
      ).toEqual([expect.objectContaining({ client, state })]);
    },
  );
});

describe("Ghidra multi-function deadline registration advice", () => {
  it.each([
    { provider: "ghidra", timeout: 10, hasBatchScope: true },
    { provider: "ghidra", timeout: 1800, hasBatchScope: true },
    { provider: "hopper", timeout: 1800, hasBatchScope: false },
  ])(
    "preserves a selected $timeout-second $provider deadline and describes its scope",
    async ({ provider, timeout, hasBatchScope }) => {
      const home = await createTestTempDirectory("rea-codex-decompile-scope-");
      await mkdir(join(home, ".codex"));
      const entry = CURRENT_ENTRYPOINT_PATH;
      if (entry === undefined) throw new Error("missing current entrypoint");
      const configPath = join(home, ".codex/config.toml");
      // Two 600-second Ghidra decompiles plus startup/headroom would need an
      // estimated 1650 seconds. A caller's shorter or longer choice stays theirs.
      const original = `[mcp_servers.xtna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = ${timeout}\n[mcp_servers.xtna.env]\nREA_ANALYSIS_PROVIDER = "${provider}"\nREA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS = "600"\n`;
      await writeFile(configPath, original);
      const [status] = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(status).toMatchObject({ client: "codex", state: "aligned" });
      if (hasBatchScope) {
        expect(status?.advisory).toContain("single-decompile estimate");
        expect(status?.advisory).toContain("every attempted function");
        expect(status?.advisory).toContain("trace_native_values");
        expect(status?.advisory).toContain("max_functions");
      } else expect(status?.advisory).toBeUndefined();
      const configured = await configureClientConfiguration(
        { name: "codex", format: "toml", configPath },
        {},
        [process.execPath, entry, "mcp"],
      );
      expect(configured).toMatchObject({ status: "unchanged" });
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(readFile(`${configPath}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("Node-wrapped registration policy", () => {
  it.each([1, 30])(
    "accepts Codex caller-selected startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-node-registration-");
      await mkdir(join(home, ".codex"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.xtna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\ntool_timeout_sec = 450\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
        }),
      ]);
    },
  );

  it("keeps a short positive Codex tool timeout aligned and reports an advisory", async () => {
    const home = await createTestTempDirectory("rea-codex-short-tool-timeout-");
    await mkdir(join(home, ".codex"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.xtna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 5\ntool_timeout_sec = 10\n`,
    );
    const [status] = await readClientRegistrationStatuses(home, entry, {
      environment: {},
    });
    expect(status).toMatchObject({
      client: "codex",
      state: "aligned",
      advisory: expect.stringContaining("tool_timeout_sec = 450 seconds"),
    });
  });

  it.each([1, 30, 90])(
    "accepts Grok Build caller-selected startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-grok-registration-");
      await mkdir(join(home, ".grok"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".grok/config.toml"),
        `[mcp_servers.xtna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "grok_build",
          state: "aligned",
        }),
      ]);
    },
  );

  it("reports Grok Build stale when rea is listed in disabled_mcp_servers", async () => {
    const home = await createTestTempDirectory("rea-grok-disabled-status-");
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["rea"]\n[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\n`,
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "stale" }),
    ]);
  });

  it("checks a direct-launcher Codex startup timeout without Node wrapping", async () => {
    const home = await createTestTempDirectory("rea-direct-registration-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.xtna]\ncommand = "/current/rea"\nargs = ["mcp"]\nstartup_timeout_sec = 1\n',
    );
    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        environment: {},
      },
    );
    expect(statuses).toEqual([
      expect.objectContaining({ client: "codex", state: "stale" }),
    ]);
  });

  it.each([{ tools: ["binary_session"] }, { tools: ["*"] }, { tools: [] }])(
    "checks Copilot tool selection $tools independently of launcher",
    async ({ tools }) => {
      const home = await createTestTempDirectory("rea-node-copilot-");
      await mkdir(join(home, ".copilot"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".copilot/mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            xtna: {
              type: "stdio",
              command: process.execPath,
              args: [entry, "mcp"],
              tools,
            },
          },
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "copilot_cli",
          state: "aligned",
        }),
      ]);
    },
  );
});

describe("explicit client selection", () => {
  // A regular file where the shared directory belongs fails every access
  // probe (ENOTDIR on POSIX, ENOENT on Windows), which is the shape an ACL
  // failure takes for automatic discovery.
  const unreachableSharedParent = async (): Promise<string> => {
    const home = await createTestTempDirectory("rea-selected-unreachable-");
    await writeFile(join(home, ".agents"), "not a directory");
    return home;
  };

  it("inspects a selected client whose config location cannot be probed", async () => {
    const home = await unreachableSharedParent();

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        environment: {},
        selectedClientIds: ["freebuff"],
      },
    );

    // Before explicit selection authorised the read, every probe failed and
    // the client was omitted, so doctor reported "not detected" instead.
    expect(statuses).toEqual([
      expect.objectContaining({
        client: "freebuff",
        config_path: join(home, ".agents", "mcp.json"),
        command: [],
      }),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "reports an unreadable selected config instead of omitting the client",
    async () => {
      const home = await unreachableSharedParent();

      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
        {
          environment: {},
          selectedClientIds: ["freebuff"],
        },
      );

      expect(statuses).toEqual([
        expect.objectContaining({
          client: "freebuff",
          state: "invalid",
          remediation: expect.stringContaining("could not be read"),
        }),
      ]);
    },
  );

  it("keeps automatic discovery probing when no client is selected", async () => {
    const home = await unreachableSharedParent();

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        environment: {},
      },
    );

    expect(statuses.map(({ client }) => client)).not.toContain("freebuff");
  });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an inaccessible configuration target instead of omitting its registration",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-target-",
    );
    const locked = join(home, "owned-denied");
    await mkdir(locked);
    const target = join(locked, "client.json");
    await writeFile(
      target,
      JSON.stringify({
        mcpServers: { xtna: { command: "rea", args: ["mcp"] } },
      }),
    );
    const path = join(home, ".claude.json");
    await symlink(target, path);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        config_path: path,
        state: "invalid",
        command: [],
        remediation: expect.stringMatching(/\S/u),
      });
      expect(
        (await existingMaintenanceScope(home, "/current/rea", process.env))
          .clients,
      ).not.toContain("claude_code");
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports an unresolved configuration location when metadata lookup is denied",
  async () => {
    const home = await createTestTempDirectory(
      "rea-registration-denied-metadata-",
    );
    const locked = join(home, "owned-denied");
    const directory = join(locked, "claude");
    await mkdir(directory, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
    await chmod(locked, 0);
    try {
      const statuses = await readClientRegistrationStatuses(
        home,
        "/current/rea",
      );
      expect(
        statuses.find((status) => status.client === "claude_code"),
      ).toMatchObject({
        state: "invalid",
        command: [],
        remediation: expect.stringContaining("EACCES"),
      });
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

it("reports a dangling configuration entry as missing without losing the detected client", async () => {
  const home = await createTestTempDirectory(
    "rea-registration-dangling-config-",
  );
  const path = join(home, ".claude.json");
  await symlink(join(home, "absent.json"), path);
  expect(
    (await readClientRegistrationStatuses(home)).find(
      (status) => status.client === "claude_code",
    ),
  ).toMatchObject({ config_path: path, state: "missing", command: [] });
});

/**
 * H2: which key the policy lists are asked about.
 *
 * The pre-existing Grok case above ("rea is listed in disabled_mcp_servers") already used the
 * historical-key input, and it was red before the fix — so it did catch the defect. What it
 * cannot show is *why*: on its own, a red there is also consistent with the launcher being
 * stale. The control below pins the delta: this exact registration is `aligned` without a list
 * entry, so the list entry alone flips the verdict.
 */
describe("registration policy key selection", () => {
  const grokRegistration = (key: "rea" | "xtna", entry: string) =>
    `[mcp_servers.${key}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\n`;

  it("suppresses a registration whose own historical key is disabled", async () => {
    const home = await createTestTempDirectory("rea-grok-legacy-disabled-");
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    // Control: the same launcher under the *current* key with no list entry is aligned, so a red
    // below is the list entry or the inherited identity, never the launcher.
    await writeFile(
      join(home, ".grok/config.toml"),
      grokRegistration("xtna", entry),
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "aligned" }),
    ]);
    const registration = grokRegistration("rea", entry);
    // Now add one entry naming the key the registration is actually stored under (§5).
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["rea"]\n${registration}`,
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "stale" }),
    ]);
  });

  it("suppresses a current-key registration when its own current key is disabled", async () => {
    const home = await createTestTempDirectory(
      "rea-grok-current-key-disabled-",
    );
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["xtna"]\n${grokRegistration("xtna", entry)}`,
    );
    // Without this case a fix that always consults the historical key would still pass.
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "stale" }),
    ]);
  });

  // §5 row 2, the mirror: a list naming the *historical* key while the member is current must
  // not produce a false red. No command can clear an entry for a name this product is not
  // registered under, so a red there would be unrepairable.
  it("keeps a current-key registration aligned when the list names the historical key", async () => {
    const home = await createTestTempDirectory("rea-grok-current-key-listed-");
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["rea"]\n${grokRegistration("xtna", entry)}`,
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "aligned" }),
    ]);
  });
});

/**
 * §5 conjunct 2: an inherited install stays `stale` until it is migrated.
 *
 * The launcher being right says the command would work; it says nothing about the member's
 * identity. Doctor reported `aligned` for a registration still stored under the historical key,
 * while setup refused to touch that same file — two answers from one product.
 */
describe("inherited identity is not health", () => {
  const codexWith = (key: string) => {
    const command = NPX_REGISTRATION_COMMAND;
    return {
      text: `[mcp_servers.${key}]\ncommand = ${JSON.stringify(command[0])}\nargs = [${command
        .slice(1)
        .map((argument) => JSON.stringify(argument))
        .join(", ")}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n`,
      command,
    };
  };

  it.each([
    ["xtna", "aligned"],
    ["rea", "stale"],
  ] as const)(
    "reports a Codex registration stored under %s as %s",
    async (key, state) => {
      const home = await createTestTempDirectory("rea-inherited-health-");
      await mkdir(join(home, ".codex"));
      const { text } = codexWith(key);
      await writeFile(join(home, ".codex/config.toml"), text);

      const statuses = await readClientRegistrationStatuses(home);
      expect(
        statuses.find((status) => status.client === "codex"),
      ).toMatchObject({ state });
    },
  );

  // §3 row 6 for a dialect that cannot migrate: the diagnosis may be `stale`, but the advice must
  // be executable. It used to say "run setup" for a file setup refuses.
  it("tells the user to remove a TOML historical entry by hand", async () => {
    const home = await createTestTempDirectory("rea-toml-manual-advice-");
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex/config.toml"), codexWith("rea").text);

    const status = (await readClientRegistrationStatuses(home)).find(
      (entry) => entry.client === "codex",
    );
    expect(status).toMatchObject({ state: "stale" });
    expect(status?.remediation).toContain("by hand");
    expect(status?.remediation).toContain("comments");
  });

  // §5 conjunct 1 and §3 row 10: two members is never healthy, however good the current one is.
  // Doctor collapsed both keys through `productServerName` and reported the pair aligned.
  it("refuses to call a dual-member document healthy", async () => {
    const home = await createTestTempDirectory("rea-dual-member-health-");
    await mkdir(join(home, ".codex"));
    const { text } = codexWith("xtna");
    await writeFile(
      join(home, ".codex/config.toml"),
      `${text}\n${codexWith("rea").text}`,
    );

    const statuses = await readClientRegistrationStatuses(home);
    expect(statuses.find((status) => status.client === "codex")).toMatchObject({
      state: "stale",
    });
  });
});

/**
 * Row 13 through the real entry point.
 *
 * Probe evidence: with two files in the OpenCode stack the reader returns both sources and the
 * merged `servers` holds both members; the earlier fixture failed only because the V2 entry schema
 * wants `type: "local"` and an array `command`, which the reader reported as `invalid`.
 */
describe("lower-layer members reach the diagnosis", () => {
  const v2 = (key: string) =>
    JSON.stringify({
      mcp: {
        servers: {
          [key]: {
            type: "local",
            command: [...NPX_REGISTRATION_COMMAND],
            enabled: true,
          },
        },
      },
    });

  it("reports a lower-layer historical member as stale, not aligned", async () => {
    const home = await createTestTempDirectory("rea-lower-layer-doctor-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    // `config.json` loads first, `opencode.json` later; the client's table merges both.
    await writeFile(join(directory, "config.json"), v2("rea"));
    await writeFile(join(directory, "opencode.json"), v2("xtna"));

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "stale" });
  });

  it("stays aligned when only the current member is present", async () => {
    const home = await createTestTempDirectory("rea-lower-layer-current-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "opencode.json"), v2("xtna"));

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "aligned" });
  });
});

/**
 * A same-key lower layer is an override, not a second registration.
 *
 * Probe evidence: the reader merges `config.json` into `opencode.json` and the later file wins for
 * the same key, so the client loads one member. Counting source records made that look like a
 * conflict and reported `stale` for a configuration the client treats as healthy.
 */
describe("same key across layers is one effective member", () => {
  const v2 = () =>
    JSON.stringify({
      mcp: {
        servers: {
          xtna: {
            type: "local",
            command: [...NPX_REGISTRATION_COMMAND],
            enabled: true,
          },
        },
      },
    });

  it("stays aligned when a later file overrides the same key", async () => {
    const home = await createTestTempDirectory("rea-same-key-doctor-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), v2());
    await writeFile(join(directory, "opencode.json"), v2());

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "aligned" });
  });

  it("still reports two distinct keys as stale", async () => {
    const home = await createTestTempDirectory("rea-two-keys-doctor-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), v2());
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: {
            rea: {
              type: "local",
              command: [...NPX_REGISTRATION_COMMAND],
              enabled: true,
            },
          },
        },
      }),
    );

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "stale" });
  });
});

/**
 * §5 conjunct 1, the other half (review 6c0959ae): a member the client loads from a lower layer is
 * not one this command can maintain. Reporting `aligned` there is health for a file setup cannot
 * write — the resolver returns no `target` for it.
 */
describe("a lower-layer-only member is not healthy", () => {
  it("reports stale when the current key exists only below the write target", async () => {
    const home = await createTestTempDirectory("rea-lower-only-current-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            xtna: {
              type: "local",
              command: [...NPX_REGISTRATION_COMMAND],
              enabled: true,
            },
          },
        },
      }),
    );
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({ mcp: {} }),
    );

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "stale" });
  });
});

/**
 * Review 6c0959ae, item 6: OpenCode stores a member in two tables. When both hold the same key the
 * record is a structural conflict (§1 D, row 10), not the one healthy member `entriesOf` used to
 * collapse it into.
 */
describe("two storage locations for one key is a conflict", () => {
  it("reports stale when V2 and V1 hold the same key", async () => {
    const home = await createTestTempDirectory("rea-v1v2-mirror-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    const entry = {
      type: "local",
      command: [...NPX_REGISTRATION_COMMAND],
      enabled: true,
    };
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({ mcp: { servers: { xtna: entry }, xtna: entry } }),
    );

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "stale" });
  });

  it("keeps a single-location member aligned", async () => {
    const home = await createTestTempDirectory("rea-v2-only-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: {
            xtna: {
              type: "local",
              command: [...NPX_REGISTRATION_COMMAND],
              enabled: true,
            },
          },
        },
      }),
    );

    const status = (await readClientRegistrationStatuses(home)).find(
      (item) => item.client === "opencode",
    );
    expect(status).toMatchObject({ state: "aligned" });
  });
});
