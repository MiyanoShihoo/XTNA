/**
 * Generate dynamic-probe skeletons from a static observation.
 *
 * The output is a starting point, not a finished probe: it records the entry
 * arguments and the return value of one address and writes them as JSON lines.
 * Nothing here executes or attaches to a target; the analyst runs the script.
 */
export interface ProbeTarget {
  /** Address the probe should hook, as written by the provider. */
  readonly address: string;
  /** Optional module or library name used to resolve the address at runtime. */
  readonly moduleName?: string;
  /** How many integer argument slots to record. */
  readonly argumentCount?: number;
  /** Caller frames to capture. */
  readonly backtraceFrames?: number;
  /** Symbol name used for readability in the generated file. */
  readonly symbol?: string;
}

export interface ProbeOptions extends ProbeTarget {
  /** Emitted at the top of the generated file. */
  readonly header?: string;
}

const DEFAULT_ARGUMENTS = 4;
const DEFAULT_FRAMES = 4;
const MAX_ARGUMENTS = 8;

const clampArguments = (value: number | undefined): number => {
  const count = value ?? DEFAULT_ARGUMENTS;
  if (!Number.isFinite(count)) return DEFAULT_ARGUMENTS;
  return Math.min(MAX_ARGUMENTS, Math.max(0, Math.trunc(count)));
};

const clampFrames = (value: number | undefined): number => {
  const count = value ?? DEFAULT_FRAMES;
  if (!Number.isFinite(count)) return DEFAULT_FRAMES;
  return Math.min(16, Math.max(0, Math.trunc(count)));
};

const quote = (value: string): string => JSON.stringify(value);

/** Frida script that records arguments and the return value of one address. */
export function generateFridaProbe(options: ProbeOptions): string {
  const args = clampArguments(options.argumentCount);
  const frames = clampFrames(options.backtraceFrames);
  const label = options.symbol ?? options.address;
  const argumentLines = Array.from(
    { length: args },
    (_, index) => `    args[${String(index)}] = ${registerFor(index)};`,
  ).join("\n");
  return [
    `// ${options.header ?? "XTNA runtime probe skeleton. Review before running."}`,
    `// target: ${label} (${options.address})`,
    "// Records entry arguments and the return value as JSON lines on stdout.",
    "",
    "const target = " + quote(options.address) + ";",
    options.moduleName === undefined
      ? "const moduleName = null;"
      : "const moduleName = " + quote(options.moduleName) + ";",
    "",
    "function resolve(address) {",
    "  if (moduleName === null) return ptr(address);",
    "  const base = Process.getModuleByName(moduleName).base;",
    "  return base.add(ptr(address).sub(base));",
    "}",
    "",
    "const address = resolve(target);",
    "Interceptor.attach(address, {",
    "  onEnter(args) {",
    "    this.entry = {",
    `      event: "enter",`,
    `      target: ${quote(label)},`,
    "      thread: Process.getCurrentThreadId(),",
    "      args: [],",
    "    };",
    argumentLines === "" ? "" : argumentLines,
    "    this.entry.backtrace = Thread.backtrace(this.context, Backtracer.ACCURATE)",
    `      .slice(0, ${String(frames)})`,
    "      .map((frame) => DebugSymbol.fromAddress(frame).toString());",
    "    send(this.entry);",
    "  },",
    "  onLeave(retval) {",
    "    send({",
    `      event: "leave",`,
    `      target: ${quote(label)},`,
    "      thread: Process.getCurrentThreadId(),",
    "      retval: retval.toInt32(),",
    "    });",
    "  },",
    "});",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Map an argument index onto the register that carries it on each ABI. */
function registerFor(index: number): string {
  const arm64 = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
  const x64 = ["rdi", "rsi", "rdx", "rcx", "r8", "r9", "r10", "r11"];
  return `this.context.${arm64[index] ?? "x0"} ?? this.context.${x64[index] ?? "rdi"}`;
}

/** LLDB Python script with the same contract as the Frida probe. */
export function generateLldbProbe(options: ProbeOptions): string {
  const args = clampArguments(options.argumentCount);
  const frames = clampFrames(options.backtraceFrames);
  const label = options.symbol ?? options.address;
  return [
    `# ${options.header ?? "XTNA LLDB probe skeleton. Review before running."}`,
    `# target: ${label} (${options.address})`,
    "# Usage: lldb -o 'command script import ./probe.py' -- <target>",
    "",
    "import json",
    "",
    "import lldb",
    "",
    `TARGET = ${quote(options.address)}`,
    `ARGUMENT_COUNT = ${String(args)}`,
    `BACKTRACE_FRAMES = ${String(frames)}`,
    "",
    "",
    "def _emit(payload):",
    "    print(json.dumps(payload), flush=True)",
    "",
    "",
    "def _on_stop(frame, bp_loc, internal_dict):",
    "    thread = frame.GetThread()",
    "    process = thread.GetProcess()",
    "    target = process.GetTarget()",
    "    address = int(TARGET, 16) if TARGET.startswith('0x') else int(TARGET)",
    "    entry = {",
    '        "event": "enter",',
    `        "target": ${quote(label)},`,
    '        "thread": thread.GetIndexID(),',
    '        "args": [],',
    "    }",
    "    registers = frame.GetRegisters()",
    "    values = []",
    "    for group in registers:",
    "        for register in group:",
    "            values.append(register.GetName())",
    "    index = 0",
    "    while index < ARGUMENT_COUNT and index < len(values):",
    '        entry["args"].append(values[index])',
    "        index += 1",
    '    entry["backtrace"] = [',
    "        str(frame.GetFrameID())",
    "        for frame in thread",
    "    ][:BACKTRACE_FRAMES]",
    "    _emit(entry)",
    "    return False",
    "",
    "",
    "def __lldb_init_module(debugger, internal_dict):",
    "    target = debugger.GetSelectedTarget()",
    "    if not target:",
    "        return",
    "    breakpoint = target.BreakpointCreateByAddress(",
    "        int(TARGET, 16) if TARGET.startswith('0x') else int(TARGET)",
    "    )",
    "    breakpoint.SetScriptCallbackFunction(__name__ + '._on_stop')",
    "",
  ].join("\n");
}

export interface ProbeRequest extends ProbeOptions {
  readonly provider: "frida" | "lldb";
}

/** Render the probe for the selected provider. */
export function generateProbe(request: ProbeRequest): string {
  return request.provider === "frida"
    ? generateFridaProbe(request)
    : generateLldbProbe(request);
}
