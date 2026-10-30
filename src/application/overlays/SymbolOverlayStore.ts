import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { err, ok, type Result } from "../../domain/result.js";

export interface SymbolHypothesis {
  readonly id: string;
  readonly target_sha256: string;
  readonly address_hex: string;
  readonly name: string;
  readonly signature?: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
}

export interface SymbolOverlaySnapshot {
  readonly version: 1;
  readonly entries: readonly SymbolHypothesis[];
}

export type SymbolOverlayError =
  | { readonly _tag: "InvalidSymbolHypothesis"; readonly reason: string }
  | { readonly _tag: "SymbolOverlayConflict"; readonly address_hex: string }
  | { readonly _tag: "SymbolOverlayStorage"; readonly cause: unknown };

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/u;
const address = /^0x[0-9a-fA-F]{1,16}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const storageFailure = (cause: unknown): SymbolOverlayError => ({
  _tag: "SymbolOverlayStorage",
  cause,
});
const normalizeAddress = (value: string): string | undefined =>
  address.test(value) ? `0x${BigInt(value).toString(16)}` : undefined;
const entryKey = (target: string, addressHex: string): string =>
  `${target}:${normalizeAddress(addressHex) ?? addressHex}`;

export class SymbolOverlayStore {
  readonly #path: string;
  #entries = new Map<string, SymbolHypothesis>();

  private constructor(path: string) {
    this.#path = path;
  }

  static async open(
    directory: string,
  ): Promise<Result<SymbolOverlayStore, SymbolOverlayError>> {
    const path = join(resolve(directory), "symbols.json");
    const store = new SymbolOverlayStore(path);
    try {
      const parsed = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<SymbolOverlaySnapshot>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries))
        return err({
          _tag: "SymbolOverlayStorage",
          cause: new Error("Unsupported symbol overlay snapshot"),
        });
      for (const entry of parsed.entries) {
        const validation = validate(entry);
        if (!validation.ok) return validation;
        const canonical = normalizeAddress(entry.address_hex);
        if (canonical === undefined)
          return err({
            _tag: "InvalidSymbolHypothesis",
            reason:
              "Address must be a 0x-prefixed hexadecimal value of at most 16 digits",
          });
        const key = entryKey(entry.target_sha256, canonical);
        if (store.#entries.has(key))
          return err({
            _tag: "SymbolOverlayStorage",
            cause: new Error(
              "Duplicate target/address entry in symbol overlay",
            ),
          });
        store.#entries.set(key, { ...entry, address_hex: canonical });
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        return err(storageFailure(cause));
    }
    return ok(store);
  }

  list(target_sha256: string): readonly SymbolHypothesis[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.target_sha256 === target_sha256)
      .sort((left, right) =>
        BigInt(left.address_hex) < BigInt(right.address_hex)
          ? -1
          : BigInt(left.address_hex) > BigInt(right.address_hex)
            ? 1
            : 0,
      );
  }

  async commit(
    input: Omit<SymbolHypothesis, "id" | "createdAt">,
  ): Promise<Result<SymbolHypothesis, SymbolOverlayError>> {
    const canonical = normalizeAddress(input.address_hex);
    if (canonical === undefined)
      return err({
        _tag: "InvalidSymbolHypothesis",
        reason:
          "Address must be a 0x-prefixed hexadecimal value of at most 16 digits",
      });
    const entry: SymbolHypothesis = {
      ...input,
      address_hex: canonical,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const validation = validate(entry);
    if (!validation.ok) return validation;
    const key = entryKey(entry.target_sha256, entry.address_hex);
    if (this.#entries.has(key))
      return err({
        _tag: "SymbolOverlayConflict",
        address_hex: entry.address_hex,
      });
    this.#entries.set(key, entry);
    const saved = await this.#save();
    if (!saved.ok) {
      this.#entries.delete(key);
      return saved;
    }
    return ok(entry);
  }

  exportMapping(
    target_sha256: string,
    format: "ghidra" | "ida" | "vscode",
  ): Result<string, SymbolOverlayError> {
    if (!sha256.test(target_sha256))
      return err({
        _tag: "InvalidSymbolHypothesis",
        reason: "Target SHA-256 must be 64 lowercase hexadecimal characters",
      });
    const entries = this.list(target_sha256);
    if (format === "ghidra")
      return ok(
        `${entries.map((entry) => `${entry.address_hex.slice(2)} ${entry.name}`).join("\n")}${entries.length > 0 ? "\n" : ""}`,
      );
    if (format === "ida")
      return ok(
        `${entries.map((entry) => `0,${entry.address_hex},${entry.name}`).join("\n")}${entries.length > 0 ? "\n" : ""}`,
      );
    return ok(
      `${JSON.stringify(
        {
          version: 1,
          target_sha256,
          symbols: entries.map(({ address_hex, name, signature }) => ({
            address: address_hex,
            name,
            ...(signature === undefined ? {} : { signature }),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  async #save(): Promise<Result<null, SymbolOverlayError>> {
    const entries = [...this.#entries.values()].sort((left, right) =>
      entryKey(left.target_sha256, left.address_hex).localeCompare(
        entryKey(right.target_sha256, right.address_hex),
      ),
    );
    const snapshot: SymbolOverlaySnapshot = { version: 1, entries };
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, this.#path);
      return ok(null);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return err(storageFailure(cause));
    }
  }
}

const validate = (
  entry: SymbolHypothesis,
): Result<null, SymbolOverlayError> => {
  const reason = (() => {
    if (!sha256.test(entry.target_sha256))
      return "Target SHA-256 must be 64 lowercase hexadecimal characters";
    if (!address.test(entry.address_hex))
      return "Address must be a 0x-prefixed hexadecimal value of at most 16 digits";
    if (!identifier.test(entry.name))
      return "Name must be a JavaScript-compatible identifier of at most 256 characters";
    if (entry.rationale.trim().length === 0)
      return "A hypothesis requires a rationale";
    if (entry.evidenceIds.length === 0)
      return "A hypothesis requires supporting evidence";
    if (new Set(entry.evidenceIds).size !== entry.evidenceIds.length)
      return "Evidence identifiers must be unique";
    if (entry.signature !== undefined && entry.signature.trim().length === 0)
      return "Signature must be non-empty when supplied";
    if (entry.id.trim().length === 0)
      return "A persisted hypothesis requires an id";
    if (Number.isNaN(Date.parse(entry.createdAt)))
      return "createdAt must be an ISO-8601 timestamp";
    return undefined;
  })();
  return reason === undefined
    ? ok(null)
    : err({ _tag: "InvalidSymbolHypothesis", reason });
};

export const symbolOverlayDigest = (
  entries: readonly SymbolHypothesis[],
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...entries].sort((left, right) =>
          entryKey(left.target_sha256, left.address_hex).localeCompare(
            entryKey(right.target_sha256, right.address_hex),
          ),
        ),
      ),
    )
    .digest("hex");
