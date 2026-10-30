#!/usr/bin/env node
/**
 * Regenerate `src/artifacts/hermes/HermesOpcodes.ts` from an upstream
 * `BytecodeList.def`.
 *
 * The table is versioned by HBC bytecode version, not by Hermes release, and
 * the jump macros expand to a short (`Addr8`) and a long (`Addr32`) opcode.
 * Guessing either from another release desynchronises every following
 * instruction, so the file records the exact upstream tag it came from.
 *
 * usage: node scripts/hermes-opcodes.mjs --def <BytecodeList.def> --version 84 --tag v0.11.0
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const defPath = flag("def");
const version = flag("version");
const tag = flag("tag");
if (defPath === undefined || version === undefined || tag === undefined) {
  process.stderr.write(
    "usage: node scripts/hermes-opcodes.mjs --def <BytecodeList.def> --version <hbc> --tag <hermes-tag>\n",
  );
  process.exit(2);
}

const OPERAND_KINDS = new Set([
  "Reg8",
  "Reg32",
  "UInt8",
  "UInt16",
  "UInt32",
  "Addr8",
  "Addr32",
  "Imm32",
  "Double",
]);

const text = await readFile(resolve(defPath), "utf8");
const opcodes = [];

const addJumpPair = (name, operands) => {
  opcodes.push({ name, operands: ["Addr8", ...operands] });
  opcodes.push({ name: `${name}Long`, operands: ["Addr32", ...operands] });
};

for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  const opcode = /^DEFINE_OPCODE_(?:(\d))?\(([^)]*)\)$/.exec(line);
  if (opcode !== null) {
    const [name, ...operands] = opcode[2].split(",").map((part) => part.trim());
    for (const operand of operands) {
      if (!OPERAND_KINDS.has(operand))
        throw new Error(`unknown operand kind ${operand} in ${line}`);
    }
    opcodes.push({ name, operands });
    continue;
  }
  const jump = /^DEFINE_JUMP_(\d)\((\w+)\)$/.exec(line);
  if (jump !== null) {
    const count = Number(jump[1]);
    const operands = Array.from({ length: count - 1 }, () => "Reg8");
    addJumpPair(jump[2], operands);
  }
}

const body = opcodes
  .map(
    (opcode) =>
      `  { name: "${opcode.name}", operands: [${opcode.operands
        .map((operand) => `"${operand}"`)
        .join(", ")}] },`,
  )
  .join("\n");

const source = `/**
 * Hermes bytecode opcode table (HBC version ${version}, Hermes ${tag}).
 *
 * Generated from that release's \`include/hermes/BCGen/HBC/BytecodeList.def\`
 * by \`scripts/hermes-opcodes.mjs\`; do not hand-edit. Jump macros expand to a
 * short \`Addr8\` opcode plus its \`Addr32\` \`...Long\` variant, and every jump
 * address is relative to the offset of the jump instruction itself.
 */
export type HermesOperandKind =
  | "Reg8"
  | "Reg32"
  | "UInt8"
  | "UInt16"
  | "UInt32"
  | "Addr8"
  | "Addr32"
  | "Imm32"
  | "Double";

export interface HermesOpcode {
  readonly name: string;
  readonly operands: readonly HermesOperandKind[];
}

export const HERMES_OPCODES_V${version}: readonly HermesOpcode[] = [
${body}
];

export const OPERAND_BYTES: Readonly<Record<HermesOperandKind, number>> = {
  Reg8: 1,
  Reg32: 4,
  UInt8: 1,
  UInt16: 2,
  UInt32: 4,
  Addr8: 1,
  Addr32: 4,
  Imm32: 4,
  Double: 8,
};

export const HERMES_OPCODE_COUNT_V${version} = ${opcodes.length};
`;

await writeFile(
  resolve("src/artifacts/hermes/HermesOpcodes.ts"),
  source,
  "utf8",
);
process.stdout.write(`wrote ${opcodes.length} opcodes for HBC ${version}\n`);
