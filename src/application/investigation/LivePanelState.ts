/**
 * Read-only state for the live investigation panel.
 *
 * The panel never writes and never evaluates: it projects the artefacts an
 * investigation already produced — an Evidence bundle, an optional symbol
 * overlay, a hypothesis file and a checkpoint directory — into one JSON
 * snapshot. Every field keeps its source path so a reviewer can go back.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  projectGraph,
  projectWaterfall,
  type PanelGraph,
  type PanelWaterfall,
} from "./PanelGraphProjection.js";

export interface PanelLimitation {
  readonly operation: string;
  readonly text: string;
}

export interface PanelSymbol {
  readonly address: string;
  readonly name: string;
  readonly kind: string;
  readonly confidence: string;
}

export interface PanelHypothesis {
  readonly id: string;
  readonly claim: string;
  readonly status: string;
  readonly confidence: string;
}

export interface PanelCheckpoint {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface PanelSnapshot {
  readonly generatedAt: string;
  readonly title: string;
  readonly sources: {
    readonly evidence: string;
    readonly overlay: string | null;
    readonly hypotheses: string | null;
    readonly checkpoints: string | null;
  };
  readonly counts: {
    readonly records: number;
    readonly artifacts: number;
    readonly unknowns: number;
    readonly limitations: number;
    readonly symbols: number;
    readonly hypotheses: number;
    readonly checkpoints: number;
    readonly graphNodes: number;
    readonly graphEdges: number;
    readonly transactions: number;
  };
  readonly graph: PanelGraph;
  readonly waterfall: PanelWaterfall;
  readonly limitations: readonly PanelLimitation[];
  readonly symbols: readonly PanelSymbol[];
  readonly hypotheses: readonly PanelHypothesis[];
  readonly checkpoints: readonly PanelCheckpoint[];
}

export interface PanelInputs {
  readonly evidencePath: string;
  readonly overlayPath?: string;
  readonly hypothesesPath?: string;
  readonly checkpointsDir?: string;
  readonly title?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/u, ""));
};

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Project the given artefacts into a single snapshot. */
export async function loadInvestigationState(
  inputs: PanelInputs,
): Promise<PanelSnapshot> {
  const evidence = await readJson(resolve(inputs.evidencePath));
  const bundle = isRecord(evidence) ? evidence : {};
  const records = asArray(bundle.records);
  const artifacts = asArray(bundle.artifacts);
  const unknowns = asArray(bundle.unknowns);
  const graph = projectGraph(records);
  const waterfall = projectWaterfall(records);

  const limitations: PanelLimitation[] = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const operation =
      typeof record.operation === "string" ? record.operation : "record";
    for (const limitation of asArray(record.limitations))
      if (typeof limitation === "string")
        limitations.push({ operation, text: limitation });
  }

  let symbols: PanelSymbol[] = [];
  let overlaySource: string | null = null;
  if (inputs.overlayPath !== undefined) {
    const overlay = await readJson(resolve(inputs.overlayPath));
    overlaySource = resolve(inputs.overlayPath);
    if (isRecord(overlay))
      symbols = asArray(overlay.entries).flatMap((entry) =>
        isRecord(entry) &&
        typeof entry.address_hex === "string" &&
        typeof entry.name === "string"
          ? [
              {
                address: entry.address_hex,
                name: entry.name,
                kind: typeof entry.kind === "string" ? entry.kind : "unknown",
                confidence:
                  typeof entry.confidence === "string"
                    ? entry.confidence
                    : "unknown",
              },
            ]
          : [],
      );
  } else {
    // Fall back to the default overlay store keyed by the bundle's target digest.
    const digest =
      typeof bundle.target_sha256 === "string" ? bundle.target_sha256 : null;
    if (digest !== null) {
      const dir = resolve(
        process.env.XTNA_OVERLAY_DIR ?? join(homedir(), ".xtna", "overlays"),
      );
      const overlay = await readJson(join(dir, `${digest}.json`)).catch(
        () => null,
      );
      if (isRecord(overlay)) {
        overlaySource = join(dir, `${digest}.json`);
        symbols = asArray(overlay.entries).flatMap((entry) =>
          isRecord(entry) &&
          typeof entry.address_hex === "string" &&
          typeof entry.name === "string"
            ? [
                {
                  address: entry.address_hex,
                  name: entry.name,
                  kind: typeof entry.kind === "string" ? entry.kind : "unknown",
                  confidence:
                    typeof entry.confidence === "string"
                      ? entry.confidence
                      : "unknown",
                },
              ]
            : [],
        );
      }
    }
  }

  let hypotheses: PanelHypothesis[] = [];
  let hypothesesSource: string | null = null;
  if (inputs.hypothesesPath !== undefined) {
    const document = await readJson(resolve(inputs.hypothesesPath));
    hypothesesSource = resolve(inputs.hypothesesPath);
    const list = isRecord(document)
      ? (document.hypotheses ?? document.items ?? document.claims)
      : document;
    hypotheses = asArray(list).flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string") return [];
      const claim =
        typeof item.claim === "string"
          ? item.claim
          : typeof item.statement === "string"
            ? item.statement
            : undefined;
      if (claim === undefined) return [];
      return [
        {
          id: item.id,
          claim,
          status: typeof item.status === "string" ? item.status : "unknown",
          confidence:
            typeof item.confidence === "string" ? item.confidence : "unknown",
        },
      ];
    });
  }

  let checkpoints: PanelCheckpoint[] = [];
  let checkpointsSource: string | null = null;
  if (inputs.checkpointsDir !== undefined) {
    const directory = resolve(inputs.checkpointsDir);
    checkpointsSource = directory;
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const entry = join(directory, name);
      const manifest = await readJson(join(entry, "manifest.json")).catch(
        () => null,
      );
      if (isRecord(manifest)) {
        const bytes = [
          ...asArray(manifest.files),
          ...asArray(manifest.overlays),
        ].reduce<number>(
          (sum, file) =>
            sum +
            (isRecord(file) && typeof file.bytes === "number" ? file.bytes : 0),
          0,
        );
        checkpoints.push({
          name:
            typeof manifest.name === "string" && manifest.name.length > 0
              ? manifest.name
              : name,
          bytes,
          modifiedAt:
            typeof manifest.created_at === "string"
              ? manifest.created_at
              : new Date().toISOString(),
        });
        continue;
      }
      const info = await stat(entry).catch(() => null);
      if (info === null || !info.isFile()) continue;
      checkpoints.push({
        name,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    title: inputs.title ?? "XTNA investigation panel",
    sources: {
      evidence: resolve(inputs.evidencePath),
      overlay: overlaySource,
      hypotheses: hypothesesSource,
      checkpoints: checkpointsSource,
    },
    counts: {
      records: records.length,
      artifacts: artifacts.length,
      unknowns: unknowns.length,
      limitations: limitations.length,
      symbols: symbols.length,
      hypotheses: hypotheses.length,
      checkpoints: checkpoints.length,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      transactions: waterfall.entries.length,
    },
    graph,
    waterfall,
    limitations,
    symbols,
    hypotheses,
    checkpoints,
  };
}

/** Stable digest of a snapshot, used by the live panel to detect changes. */
export function snapshotDigest(snapshot: PanelSnapshot): string {
  const stable = {
    counts: snapshot.counts,
    graph: snapshot.graph,
    waterfall: snapshot.waterfall,
    limitations: snapshot.limitations,
    symbols: snapshot.symbols,
    hypotheses: snapshot.hypotheses,
    checkpoints: snapshot.checkpoints,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
