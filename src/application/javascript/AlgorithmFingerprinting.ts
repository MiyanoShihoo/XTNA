import { err, ok, type Result } from "../../domain/result.js";

export type AlgorithmFamily =
  | "aes"
  | "crc32"
  | "base64"
  | "gzip"
  | "lz4"
  | "pem"
  | "xz"
  | "zlib"
  | "zstd"
  | "md5"
  | "sha1"
  | "sha224"
  | "sha256"
  | "sha384"
  | "sha512"
  | "protobuf";

export interface FingerprintLimits {
  readonly maxSourceBytes: number;
  readonly maxFindings: number;
  readonly maxProtobufCandidates: number;
  readonly maxProtobufBytes: number;
}

export interface FingerprintOptions {
  readonly maxSourceBytes?: number;
  readonly maxFindings?: number;
  readonly maxProtobufCandidates?: number;
  readonly maxProtobufBytes?: number;
}

export type FingerprintError =
  | {
      readonly code: "invalid_options";
      readonly message: string;
      readonly option: string;
    }
  | {
      readonly code: "source_too_large";
      readonly message: string;
      readonly actual: number;
      readonly limit: number;
    };

export interface FingerprintEvidence {
  readonly kind:
    | "byte-signature"
    | "numeric-constants"
    | "header-validation"
    | "wire-structure";
  readonly description: string;
  readonly bytes: number;
  readonly value: string;
}

export interface AlgorithmFingerprint {
  readonly algorithm: AlgorithmFamily;
  readonly category:
    | "checksum"
    | "cipher"
    | "encoding"
    | "compression"
    | "hash"
    | "key-material"
    | "serialization";
  readonly offset: number;
  readonly length: number;
  readonly confidence: "low" | "medium" | "high";
  readonly evidence: readonly FingerprintEvidence[];
}

export interface FingerprintUnknown {
  readonly code: "findings-truncated" | "protobuf-candidates-truncated";
  readonly message: string;
  readonly omitted: number;
}

export interface AlgorithmFingerprintResult {
  readonly fingerprints: readonly AlgorithmFingerprint[];
  readonly unknowns: readonly FingerprintUnknown[];
  readonly coverage: "complete" | "partial";
  readonly examinedBytes: number;
  readonly limits: FingerprintLimits;
}

const DEFAULT_LIMITS: FingerprintLimits = {
  maxSourceBytes: 16 * 1024 * 1024,
  maxFindings: 1_000,
  maxProtobufCandidates: 100,
  maxProtobufBytes: 256,
};
const HARD_LIMITS: FingerprintLimits = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxFindings: 10_000,
  maxProtobufCandidates: 1_000,
  maxProtobufBytes: 4_096,
};

const resolveLimits = (
  options: FingerprintOptions,
): Result<FingerprintLimits, FingerprintError> => {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(
    DEFAULT_LIMITS,
  ) as (keyof FingerprintLimits)[]) {
    const value = options[key];
    if (value === undefined) continue;
    const minimum =
      key === "maxFindings" || key === "maxProtobufCandidates" ? 0 : 16;
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > HARD_LIMITS[key]
    )
      return err({
        code: "invalid_options",
        option: key,
        message: `${key} must be an integer from ${minimum} through ${HARD_LIMITS[key]}.`,
      });
    limits[key] = value;
  }
  return ok(limits);
};

const hex = (text: string): Uint8Array => {
  const clean = text.replace(/\s+/gu, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const previewHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

interface Signature {
  readonly algorithm: AlgorithmFamily;
  readonly category: AlgorithmFingerprint["category"];
  readonly bytes: Uint8Array;
  readonly description: string;
  readonly confidence: AlgorithmFingerprint["confidence"];
}

const SIGNATURES: readonly Signature[] = [
  {
    algorithm: "aes",
    category: "cipher",
    bytes: hex("637c777bf26b6fc53001672bfed7ab76"),
    confidence: "high",
    description: "AES S-box table prefix.",
  },
  {
    algorithm: "aes",
    category: "cipher",
    bytes: hex("52096ad53036a538bf40a39e81f3d7fb"),
    confidence: "high",
    description: "AES inverse S-box table prefix.",
  },
  {
    algorithm: "gzip",
    category: "compression",
    bytes: hex("1f8b08"),
    confidence: "high",
    description: "Gzip header magic and deflate method.",
  },
  {
    algorithm: "xz",
    category: "compression",
    bytes: hex("fd377a585a00"),
    confidence: "high",
    description: "XZ stream header magic.",
  },
  {
    algorithm: "lz4",
    category: "compression",
    bytes: hex("04224d18"),
    confidence: "high",
    description: "LZ4 frame magic.",
  },
  {
    algorithm: "pem",
    category: "key-material",
    bytes: ascii("-----BEGIN PRIVATE KEY-----"),
    confidence: "high",
    description: "PEM PKCS#8 private-key header.",
  },
  {
    algorithm: "pem",
    category: "key-material",
    bytes: ascii("-----BEGIN RSA PRIVATE KEY-----"),
    confidence: "high",
    description: "PEM RSA private-key header.",
  },
  {
    algorithm: "pem",
    category: "key-material",
    bytes: ascii("-----BEGIN OPENSSH PRIVATE KEY-----"),
    confidence: "high",
    description: "PEM OpenSSH private-key header.",
  },
  {
    algorithm: "base64",
    category: "encoding",
    bytes: ascii(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    ),
    confidence: "high",
    description: "Complete standard Base64 alphabet.",
  },
  {
    algorithm: "base64",
    category: "encoding",
    bytes: ascii(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    ),
    confidence: "high",
    description: "Complete URL-safe Base64 alphabet.",
  },
  {
    algorithm: "zstd",
    category: "compression",
    bytes: hex("28b52ffd"),
    confidence: "high",
    description: "Zstandard frame magic.",
  },
  {
    algorithm: "md5",
    category: "hash",
    bytes: hex("0123456789abcdeffedcba9876543210"),
    confidence: "high",
    description: "MD5 initial state in little-endian words.",
  },
  {
    algorithm: "md5",
    category: "hash",
    bytes: hex("67452301efcdab8998badcfe10325476"),
    confidence: "medium",
    description: "MD5 initial state in big-endian words; shared with SHA-1.",
  },
  {
    algorithm: "sha1",
    category: "hash",
    bytes: hex("67452301efcdab8998badcfe103254765a827999"),
    confidence: "high",
    description: "Complete SHA-1 initial state.",
  },
  {
    algorithm: "sha1",
    category: "hash",
    bytes: hex("0123456789abcdeffedcba9876543210c3d2e1f0"),
    confidence: "high",
    description: "Complete SHA-1 initial state in little-endian words.",
  },
  {
    algorithm: "sha224",
    category: "hash",
    bytes: hex("c1059ed8367cd5073070dd17f70e5939"),
    confidence: "high",
    description: "SHA-224 initial hash prefix.",
  },
  {
    algorithm: "sha256",
    category: "hash",
    bytes: hex("6a09e667bb67ae853c6ef372a54ff53a"),
    confidence: "high",
    description: "SHA-256 initial hash prefix.",
  },
  {
    algorithm: "sha256",
    category: "hash",
    bytes: hex("67e6096a85ae67bb72f36e3c3af54fa5"),
    confidence: "high",
    description: "SHA-256 initial hash prefix in little-endian words.",
  },
  {
    algorithm: "sha384",
    category: "hash",
    bytes: hex("cbbb9d5dc1059ed8629a292a367cd507"),
    confidence: "high",
    description: "SHA-384 initial hash prefix.",
  },
  {
    algorithm: "sha512",
    category: "hash",
    bytes: hex("6a09e667f3bcc908bb67ae8584caa73b"),
    confidence: "high",
    description: "SHA-512 initial hash prefix.",
  },
  {
    algorithm: "sha512",
    category: "hash",
    bytes: hex("08c9bcf367e6096a3ba7c84885ae67bb"),
    confidence: "high",
    description: "SHA-512 initial hash prefix in little-endian words.",
  },
  {
    algorithm: "crc32",
    category: "checksum",
    bytes: hex("00000000963007772c610eee"),
    confidence: "high",
    description:
      "Reflected CRC-32/ISO-HDLC table prefix in little-endian words.",
  },
  {
    algorithm: "crc32",
    category: "checksum",
    bytes: hex("0000000077073096ee0e612c"),
    confidence: "high",
    description: "CRC-32/ISO-HDLC table prefix in big-endian words.",
  },
  {
    algorithm: "crc32",
    category: "checksum",
    bytes: hex("00000000f26b8303e13b70f1"),
    confidence: "high",
    description: "Reflected CRC-32C table prefix in little-endian words.",
  },
  {
    algorithm: "crc32",
    category: "checksum",
    bytes: hex("0000000003836bf2f1703be1"),
    confidence: "high",
    description: "CRC-32C table prefix in big-endian words.",
  },
];

const NUMERIC_SIGNATURES = [
  {
    algorithm: "crc32" as const,
    values: ["0xedb88320", "79764919"],
    description: "Reflected CRC-32/ISO-HDLC polynomial.",
  },
  {
    algorithm: "crc32" as const,
    values: ["0x82f63b78", "2197175160"],
    description: "Reflected CRC-32C polynomial.",
  },
  {
    algorithm: "sha256" as const,
    values: ["0x6a09e667", "1779033703", "0xbb67ae85", "3144134277"],
    description: "SHA-256 initial word.",
  },
  {
    algorithm: "sha1" as const,
    values: ["0x67452301", "1732584193"],
    description:
      "SHA-1/MD5 initial word; additional evidence is required to distinguish them.",
  },
  {
    algorithm: "md5" as const,
    values: ["0x67452301", "1732584193"],
    description:
      "SHA-1/MD5 initial word; additional evidence is required to distinguish them.",
  },
] as const;

const matches = (
  source: Uint8Array,
  offset: number,
  signature: Uint8Array,
): boolean => {
  if (offset + signature.length > source.length) return false;
  for (let index = 0; index < signature.length; index += 1)
    if (source[offset + index] !== signature[index]) return false;
  return true;
};

const numericEvidence = (
  source: Uint8Array,
  values: readonly string[],
): { offset: number; length: number; value: string } | undefined => {
  const text = new TextDecoder().decode(source);
  for (const value of values) {
    const pattern = new RegExp(`(?<![\\w])${value}(?![\\w])`, "giu");
    const found = pattern.exec(text);
    if (found !== null)
      return { offset: found.index, length: found[0].length, value: found[0] };
  }
  return undefined;
};

const isZlibHeader = (source: Uint8Array, offset: number): boolean => {
  if (offset + 2 > source.length) return false;
  const cmf = source[offset] as number;
  const flg = source[offset + 1] as number;
  return (cmf & 0x0f) === 8 && cmf >>> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
};

interface ProtobufField {
  readonly number: number;
  readonly wireType: number;
}
const readVarint = (
  source: Uint8Array,
  start: number,
  end: number,
): { value: number; next: number } | undefined => {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < end && offset - start < 10; offset += 1) {
    const byte = source[offset] as number;
    if (shift >= 32 && (byte & 0x7f) !== 0) return undefined;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    shift += 7;
  }
  return undefined;
};

const protobufCandidate = (
  source: Uint8Array,
  offset: number,
  maxBytes: number,
): { fields: readonly ProtobufField[]; length: number } | undefined => {
  const end = Math.min(source.length, offset + maxBytes);
  let cursor = offset;
  const fields: ProtobufField[] = [];
  while (cursor < end && fields.length < 16) {
    const key = readVarint(source, cursor, end);
    if (key === undefined || key.value === 0) break;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (number < 1 || number > 536_870_911 || ![0, 1, 2, 5].includes(wireType))
      break;
    fields.push({ number, wireType });
    cursor = key.next;
    if (wireType === 0) {
      const value = readVarint(source, cursor, end);
      if (value === undefined) return undefined;
      cursor = value.next;
    } else if (wireType === 1) cursor += 8;
    else if (wireType === 5) cursor += 4;
    else {
      const length = readVarint(source, cursor, end);
      if (length === undefined || length.value > end - length.next)
        return undefined;
      cursor = length.next + length.value;
    }
    if (cursor > end) return undefined;
  }
  return fields.length >= 2 ? { fields, length: cursor - offset } : undefined;
};

/** Locate static algorithm evidence without decoding, decompressing, or executing source. */
// oxlint-disable-next-line complexity
export function fingerprintAlgorithms(
  source: Uint8Array,
  options: FingerprintOptions = {},
): Result<AlgorithmFingerprintResult, FingerprintError> {
  const limitsResult = resolveLimits(options);
  if (!limitsResult.ok) return limitsResult;
  const limits = limitsResult.value;
  if (source.byteLength > limits.maxSourceBytes)
    return err({
      code: "source_too_large",
      actual: source.byteLength,
      limit: limits.maxSourceBytes,
      message: `Input is ${source.byteLength} bytes; the limit is ${limits.maxSourceBytes}.`,
    });

  const fingerprints: AlgorithmFingerprint[] = [];
  let omitted = 0;
  let omittedProtobuf = 0;
  const retain = (finding: AlgorithmFingerprint, protobuf = false): void => {
    if (fingerprints.length < limits.maxFindings) fingerprints.push(finding);
    else {
      omitted += 1;
      if (protobuf) omittedProtobuf += 1;
    }
  };

  for (const signature of SIGNATURES) {
    const last = source.length - signature.bytes.length;
    for (let offset = 0; offset <= last; offset += 1) {
      if (!matches(source, offset, signature.bytes)) continue;
      retain({
        algorithm: signature.algorithm,
        category: signature.category,
        offset,
        length: signature.bytes.length,
        confidence: signature.confidence,
        evidence: [
          {
            kind: "byte-signature",
            description: signature.description,
            bytes: signature.bytes.length,
            value: previewHex(signature.bytes),
          },
        ],
      });
    }
  }

  for (const signature of NUMERIC_SIGNATURES) {
    const found = numericEvidence(source, signature.values);
    if (found === undefined) continue;
    retain({
      algorithm: signature.algorithm,
      category: signature.algorithm === "crc32" ? "checksum" : "hash",
      offset: found.offset,
      length: found.length,
      confidence: signature.algorithm === "crc32" ? "high" : "medium",
      evidence: [
        {
          kind: "numeric-constants",
          description: signature.description,
          bytes: found.length,
          value: found.value,
        },
      ],
    });
  }

  const ambiguousHashOffsets = new Set<number>();
  for (const finding of fingerprints)
    if (
      finding.algorithm === "sha1" &&
      finding.evidence.some((item) => item.bytes >= 20)
    )
      for (
        let offset = finding.offset;
        offset < finding.offset + 16;
        offset += 1
      )
        ambiguousHashOffsets.add(offset);
  for (let index = fingerprints.length - 1; index >= 0; index -= 1) {
    const finding = fingerprints[index] as AlgorithmFingerprint;
    if (
      finding.algorithm === "md5" &&
      finding.length === 16 &&
      ambiguousHashOffsets.has(finding.offset)
    )
      fingerprints.splice(index, 1);
  }

  for (let offset = 0; offset + 2 <= source.length; offset += 1) {
    if (!isZlibHeader(source, offset)) continue;
    const header = source.slice(offset, offset + 2);
    retain({
      algorithm: "zlib",
      category: "compression",
      offset,
      length: 2,
      confidence: "medium",
      evidence: [
        {
          kind: "header-validation",
          description:
            "Deflate CMF/FLG passes method, window-size, and FCHECK validation; two-byte coincidence remains possible.",
          bytes: 2,
          value: previewHex(header),
        },
      ],
    });
  }

  if (limits.maxProtobufCandidates > 0) {
    let protobufCandidates = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      if (protobufCandidates >= limits.maxProtobufCandidates) {
        omittedProtobuf = source.length - offset;
        break;
      }
      const candidate = protobufCandidate(
        source,
        offset,
        limits.maxProtobufBytes,
      );
      if (candidate === undefined) continue;
      protobufCandidates += 1;
      retain(
        {
          algorithm: "protobuf",
          category: "serialization",
          offset,
          length: candidate.length,
          confidence: "low",
          evidence: [
            {
              kind: "wire-structure",
              description:
                "Bounded protobuf field walk; valid wire structure alone does not establish a schema or protocol.",
              bytes: candidate.length,
              value: candidate.fields
                .map((field) => `${field.number}:${field.wireType}`)
                .join(","),
            },
          ],
        },
        true,
      );
    }
  }

  fingerprints.sort(
    (left, right) =>
      left.offset - right.offset ||
      left.algorithm.localeCompare(right.algorithm),
  );
  const unknowns: FingerprintUnknown[] = [];
  if (omitted > 0)
    unknowns.push({
      code: "findings-truncated",
      omitted,
      message: `${omitted} matching fingerprints exceeded maxFindings; the complete input was scanned.`,
    });
  if (omittedProtobuf > 0)
    unknowns.push({
      code: "protobuf-candidates-truncated",
      omitted: omittedProtobuf,
      message: `${omittedProtobuf} candidate findings or unchecked offsets exceeded the protobuf candidate bound.`,
    });
  return ok({
    fingerprints,
    unknowns,
    coverage: omittedProtobuf > 0 ? "partial" : "complete",
    examinedBytes: source.byteLength,
    limits,
  });
}
