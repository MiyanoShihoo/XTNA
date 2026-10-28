/**
 * Presentation-only symbol overlay rendering.
 *
 * Evidence text is never mutated in place. This module rewrites a *copy* of a
 * pseudocode or disassembly string for display, replacing address-derived
 * placeholder identifiers with analyst-proposed names from the overlay store.
 */
export interface OverlayEntryLike {
  readonly address_hex: string;
  readonly name: string;
}

export interface OverlayRenderResult {
  readonly text: string;
  readonly replacements: ReadonlyArray<{ from: string; to: string }>;
}

/** Identifiers a decompiler derives from an address. */
const PLACEHOLDER = /\b(?:sub|FUN|nullsub|loc|j|LAB|thunk_FUN)_([0-9a-fA-F]{6,16})\b/gu;

const normaliseAddress = (hex: string): string => {
  const value = BigInt(`0x${hex}`);
  return `0x${value.toString(16)}`;
};

/**
 * Replace address-derived identifiers with overlay names.
 * Unknown placeholders are left untouched; nothing is invented.
 */
export function applySymbolOverlay(
  text: string,
  entries: readonly OverlayEntryLike[],
): OverlayRenderResult {
  const byAddress = new Map<string, string>();
  for (const entry of entries) {
    const key = normaliseAddress(entry.address_hex.replace(/^0x/u, ""));
    byAddress.set(key, entry.name);
  }
  const replacements: Array<{ from: string; to: string }> = [];
  const rendered = text.replace(PLACEHOLDER, (match, hex: string) => {
    const name = byAddress.get(normaliseAddress(hex));
    if (name === undefined) return match;
    replacements.push({ from: match, to: name });
    return name;
  });
  return { text: rendered, replacements };
}

/** True when a string carries at least one placeholder this module understands. */
export function hasAddressPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}
