import { randomBytes } from "node:crypto";

/**
 * Session-scoped placeholder vault.
 *
 * Outbound: a real secret is replaced with a placeholder and interned here.
 * Inbound:  the placeholder is expanded back to the real value before the call
 *           reaches the upstream server.
 *
 * The nonce makes it effectively impossible for a model to invent a
 * placeholder that maps to something real, and prevents replay from an older
 * session from resolving against this one.
 */
export class Vault {
  private readonly byPlaceholder = new Map<string, string>();
  private readonly byValue = new Map<string, string>();
  private readonly nonce: string;
  private readonly pattern: RegExp;
  private counter = 0;

  constructor(
    private readonly marker: string = "vault",
    nonce?: string,
  ) {
    // A caller-supplied nonce keeps placeholder identity reproducible in tests;
    // production always randomises it per process.
    this.nonce = nonce ?? randomBytes(3).toString("hex");
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.pattern = new RegExp(`<${escaped}:(\\d+):${this.nonce}>`, "g");
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  get id(): string {
    return this.nonce;
  }

  /** Placeholder text for a given real value, creating one on first sight. */
  intern(realValue: string): string {
    const existing = this.byValue.get(realValue);
    if (existing) return existing;

    this.counter += 1;
    const placeholder = `<${this.marker}:${this.counter}:${this.nonce}>`;
    this.byPlaceholder.set(placeholder, realValue);
    this.byValue.set(realValue, placeholder);
    return placeholder;
  }

  resolve(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  /** True if this text contains at least one of our placeholders. */
  containsPlaceholder(text: string): boolean {
    this.pattern.lastIndex = 0;
    return this.pattern.test(text);
  }

  /** Replace every known placeholder in a string with its real value. */
  expand(text: string): string {
    this.pattern.lastIndex = 0;
    return text.replace(
      this.pattern,
      (match) => this.byPlaceholder.get(match) ?? match,
    );
  }

  /** Structural expansion over a JSON-compatible value. Returns a new tree. */
  expandDeep<T>(value: T): T {
    if (typeof value === "string") return this.expand(value) as unknown as T;
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((v) => this.expandDeep(v)) as unknown as T;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are never expanded: they are structure, not payload.
      out[k] = this.expandDeep(v);
    }
    return out as unknown as T;
  }

  /** Placeholder metadata without the secret material. */
  inventory(): Array<{ placeholder: string; length: number }> {
    return [...this.byPlaceholder.entries()].map(([placeholder, value]) => ({
      placeholder,
      length: value.length,
    }));
  }

  clear(): void {
    this.byPlaceholder.clear();
    this.byValue.clear();
    this.counter = 0;
  }
}
