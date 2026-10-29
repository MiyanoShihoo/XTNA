import { describe, expect, it } from "vitest";

import {
  generateFridaProbe,
  generateLldbProbe,
  generateProbe,
} from "./RuntimeProbeGeneration.js";

describe("frida probe", () => {
  it("hooks the address and records argument registers", () => {
    const script = generateFridaProbe({
      address: "0x40100b",
      argumentCount: 3,
      backtraceFrames: 2,
      symbol: "parseOrder",
    });
    expect(script).toContain("Interceptor.attach");
    expect(script).toContain('const target = "0x40100b";');
    expect(script).toContain("args[0] = this.context.x0 ?? this.context.rdi;");
    expect(script).toContain("args[1] = this.context.x1 ?? this.context.rsi;");
    expect(script).toContain("args[2] = this.context.x2 ?? this.context.rdx;");
    expect(script).not.toContain("args[3]");
    expect(script).toContain(".slice(0, 2)");
    expect(script).toContain('target: "parseOrder"');
  });

  it("clamps an oversized argument count", () => {
    const script = generateFridaProbe({ address: "0x1000", argumentCount: 99 });
    expect(script).toContain("args[7]");
    expect(script).not.toContain("args[8]");
  });

  it("resolves through a module when one is given", () => {
    const script = generateFridaProbe({
      address: "0x1000",
      moduleName: "target.exe",
    });
    expect(script).toContain('const moduleName = "target.exe";');
    expect(script).toContain("Process.getModuleByName(moduleName)");
  });
});

describe("lldb probe", () => {
  it("creates a breakpoint and emits JSON", () => {
    const script = generateLldbProbe({ address: "0x40100b", argumentCount: 2 });
    expect(script).toContain("import lldb");
    expect(script).toContain("BreakpointCreateByAddress");
    expect(script).toContain("ARGUMENT_COUNT = 2");
    expect(script).toContain("json.dumps");
  });
});

describe("provider selection", () => {
  it("routes to the requested provider", () => {
    expect(generateProbe({ provider: "frida", address: "0x1" })).toContain(
      "Interceptor.attach",
    );
    expect(generateProbe({ provider: "lldb", address: "0x1" })).toContain(
      "BreakpointCreateByAddress",
    );
  });

  it("is deterministic", () => {
    const options = { address: "0x40100b", argumentCount: 2 } as const;
    expect(generateFridaProbe(options)).toBe(generateFridaProbe(options));
  });
});
