/**
 * Discover and analyse WebAssembly modules under a directory.
 *
 * Detection is by magic (`\0asm`), not by extension, so a renamed or
 * extension-less module is still found. Every file is bounded: a scan caps the
 * number of files, the per-file bytes it will parse, and the directory depth.
 * Files that are not wasm are counted and skipped, never reported as empty
 * modules.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readWasmCallGraph, type WasmCallGraph } from "./WasmCallGraph.js";

export interface WasmModuleFinding {
  readonly path: string;
  readonly bytes: number;
  readonly functions: number;
  readonly edges: number;
  readonly undecodedFunctions: number;
}

export interface WasmScanReport {
  readonly root: string;
  readonly modules: readonly WasmModuleFinding[];
  readonly scannedFiles: number;
  readonly skippedNonWasm: number;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface WasmScanOptions {
  /** Maximum files examined. Defaults to 500. */
  readonly maxFiles?: number;
  /** Maximum bytes per module that will be parsed. Defaults to 16 MiB. */
  readonly maxModuleBytes?: number;
  /** Maximum directory depth below the root. Defaults to 8. */
  readonly maxDepth?: number;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

const hasWasmMagic = async (path: string): Promise<boolean> => {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      WASM_MAGIC.every((byte, index) => header[index] === byte)
    );
  } finally {
    await handle.close();
  }
};

const readBounded = async (
  path: string,
  bytes: number,
  maxBytes: number,
): Promise<Buffer | undefined> => {
  if (bytes > maxBytes) return undefined;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/**
 * Walk `root`, parse every wasm module it finds and aggregate the call graphs.
 * The walk is breadth-first and stops cleanly at the file/depth bounds.
 */
export async function scanWasmDirectory(
  root: string,
  options: WasmScanOptions = {},
): Promise<WasmScanReport> {
  const maxFiles = Math.max(1, options.maxFiles ?? 500);
  const maxModuleBytes = Math.max(
    1,
    options.maxModuleBytes ?? 16 * 1024 * 1024,
  );
  const maxDepth = Math.max(0, options.maxDepth ?? 8);
  const absoluteRoot = resolve(root);
  const modules: WasmModuleFinding[] = [];
  const limitations: string[] = [];
  let scannedFiles = 0;
  let skippedNonWasm = 0;
  let truncated = false;
  const queue: { path: string; depth: number }[] = [
    { path: absoluteRoot, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      limitations.push(`Unreadable directory skipped: ${current.path}`);
      continue;
    }
    for (const entry of entries) {
      if (scannedFiles >= maxFiles) {
        truncated = true;
        break;
      }
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth)
          queue.push({ path, depth: current.depth + 1 });
        else truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles += 1;
      const info = await stat(path).catch(() => null);
      if (info === null) {
        limitations.push(`Unreadable file skipped: ${path}`);
        continue;
      }
      const magic = await hasWasmMagic(path).catch(() => false);
      if (!magic) {
        skippedNonWasm += 1;
        continue;
      }
      if (info.size > maxModuleBytes) {
        limitations.push(
          `Module above the per-file cap skipped: ${path} (${String(info.size)} bytes)`,
        );
        continue;
      }
      const bytes = await readBounded(path, info.size, maxModuleBytes).catch(
        () => undefined,
      );
      if (bytes === undefined) {
        limitations.push(`Module could not be read: ${path}`);
        continue;
      }
      const graph = readWasmCallGraph(bytes);
      if (!graph.ok) {
        limitations.push(`Module not parsed (${graph.error.code}): ${path}`);
        continue;
      }
      modules.push({
        path,
        bytes: info.size,
        functions: graph.value.functions.length,
        edges: graph.value.edges.length,
        undecodedFunctions: graph.value.undecodedFunctions.length,
      });
    }
    if (truncated) break;
  }
  if (truncated && scannedFiles >= maxFiles)
    limitations.push(`Stopped after ${String(maxFiles)} files.`);
  return {
    root: absoluteRoot,
    modules,
    scannedFiles,
    skippedNonWasm,
    truncated,
    limitations,
  };
}

export type { WasmCallGraph };
