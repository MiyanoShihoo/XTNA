#!/usr/bin/env node
/**
 * Constant-signature radar: find well-known crypto, compression and encoding
 * tables in a local file.
 *
 * Signature matching is evidence of bytes, not proof that the code uses the
 * algorithm. Every hit is reported with its offset so it can be verified.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
const json = args.includes("--json");
if (path === undefined) {
  process.stderr.write(
    "usage: node scripts/crypto-radar.mjs <file> [--json]\n",
  );
  process.exit(2);
}

const buffer = await readFile(resolve(path));

const hex = (text) => Buffer.from(text.replace(/\s+/gu, ""), "hex");
const ascii = (text) => Buffer.from(text, "latin1");

const SIGNATURES = [
  {
    name: "AES S-box",
    bytes: hex("637c777bf26b6fc53001672bfed7ab76"),
    kind: "crypto-table",
  },
  {
    name: "AES inverse S-box",
    bytes: hex("52096ad53036a538bf40a39e81f3d7fb"),
    kind: "crypto-table",
  },
  {
    name: "SHA-256 initial hash",
    bytes: hex("6a09e667bb67ae853c6ef372a54ff53a"),
    kind: "crypto-constant",
  },
  {
    name: "SHA-1 / MD5 initial state",
    bytes: hex("67452301efcdab8998badcfe10325476"),
    kind: "crypto-constant",
  },
  {
    name: "CRC32 table entry pair",
    bytes: hex("000000009630 0777"),
    kind: "checksum-table",
  },
  { name: "zlib header 78 9c", bytes: hex("789c"), kind: "compression" },
  { name: "zlib header 78 da", bytes: hex("78da"), kind: "compression" },
  { name: "gzip header", bytes: hex("1f8b08"), kind: "compression" },
  { name: "zstd frame magic", bytes: hex("28b52ffd"), kind: "compression" },
  { name: "xz stream header", bytes: hex("fd377a585a00"), kind: "compression" },
  { name: "LZ4 frame magic", bytes: hex("04224d18"), kind: "compression" },
  {
    name: "Base64 alphabet",
    bytes: ascii(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    ),
    kind: "encoding-table",
  },
  {
    name: "Base64 URL alphabet",
    bytes: ascii(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    ),
    kind: "encoding-table",
  },
  {
    name: "PEM private key",
    bytes: ascii("-----BEGIN PRIVATE KEY-----"),
    kind: "key-material",
  },
  {
    name: "PEM RSA private key",
    bytes: ascii("-----BEGIN RSA PRIVATE KEY-----"),
    kind: "key-material",
  },
  {
    name: "OpenSSH private key",
    bytes: ascii("-----BEGIN OPENSSH PRIVATE KEY-----"),
    kind: "key-material",
  },
  {
    name: "Protobuf varint field marker",
    bytes: hex("0a"),
    kind: "encoding-hint",
    hint: true,
  },
];

const includeHints = args.includes("--include-hints");
const hits = [];
for (const signature of SIGNATURES) {
  if (signature.hint === true && !includeHints) continue;
  let from = 0;
  for (;;) {
    const at = buffer.indexOf(signature.bytes, from);
    if (at < 0) break;
    hits.push({
      offset: at,
      offset_hex: `0x${at.toString(16)}`,
      name: signature.name,
      kind: signature.kind,
    });
    from = at + 1;
    if (hits.length > 5000) break;
  }
}

hits.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));

const report = {
  artifact: { path: resolve(path), bytes: buffer.length },
  hits,
  counts_by_kind: hits.reduce((acc, hit) => {
    acc[hit.kind] = (acc[hit.kind] ?? 0) + 1;
    return acc;
  }, {}),
  limitations: [
    "A constant table means the data is present, not that the code calls that algorithm.",
    "Absence of a signature is not proof of absence: tables are often generated at runtime or stored obfuscated.",
    "The Protobuf marker is a single byte and will produce many unrelated hits; treat it as a hint only.",
  ],
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`file    ${resolve(path)}`);
  console.log(`bytes   ${String(buffer.length)}`);
  console.log(`hits    ${String(hits.length)}`);
  for (const [kind, count] of Object.entries(report.counts_by_kind))
    console.log(`  ${kind.padEnd(16)} ${String(count)}`);
  console.log("");
  for (const hit of hits.slice(0, 40))
    console.log(
      `${hit.offset_hex.padEnd(10)} ${hit.kind.padEnd(16)} ${hit.name}`,
    );
  if (hits.length > 40) console.log(`鈥?${String(hits.length - 40)} more`);
}
