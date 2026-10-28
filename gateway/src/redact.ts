import type { RedactionConfig } from './config.js';
import type { Vault } from './vault.js';

/**
 * Detector contract. When `group` is set only that capture group is replaced,
 * which lets a rule keep descriptive context ("Authorization: Bearer xxx")
 * while redacting only the credential itself.
 */
interface Detector {
  name: string;
  regex: RegExp;
  group?: number;
}

/** Built-in detectors, ordered so specific formats win over generic ones. */
const DETECTORS: Detector[] = [
  {
    name: 'pem-private-key',
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{32,}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { name: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|APKA)[0-9A-Z]{16}\b/g },
  {
    name: 'aws-secret-access-key',
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["'\s]*[:=]["'\s]*([A-Za-z0-9/+=]{40})/g,
    group: 1,
  },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{32,255}\b/g },
  { name: 'gitlab-pat', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'pypi-token', regex: /\bpypi-[A-Za-z0-9_-]{50,}\b/g },
  { name: 'sendgrid-key', regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { name: 'twilio-key', regex: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: 'shopify-token', regex: /\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b/g },
  { name: 'telegram-bot-token', regex: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { name: 'azure-storage-key', regex: /AccountKey=([A-Za-z0-9+/=]{80,})/g, group: 1 },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'url-credentials',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]{4,})@/gi,
    group: 1,
  },
  {
    name: 'connection-string-password',
    regex: /\b(?:Password|Pwd)=([^;"'\s]{6,})/gi,
    group: 1,
  },
  {
    name: 'bearer-token',
    regex: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}=*)/g,
    group: 1,
  },
  {
    name: 'basic-auth-header',
    regex: /\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/]{16,}=*)/gi,
    group: 1,
  },
  {
    name: 'key-value-secret',
    regex:
      /(?:\bapi[_-]?key|\bsecret[_-]?key|\bclient[_-]?secret|\baccess[_-]?token|\brefresh[_-]?token|\bauth[_-]?token|\bprivate[_-]?key|\bpassword|\bpasswd)\b["'\s]*[:=]\s*["']?([A-Za-z0-9\-._~+/=]{12,})["']?/gi,
    group: 1,
  },
];

export interface RedactionHit {
  detector: string;
  length: number;
  placeholder: string;
}

export interface RedactResult<T> {
  value: T;
  hits: RedactionHit[];
}

interface Range {
  start: number;
  end: number;
  detector: string;
}

export class Redactor {
  private readonly detectors: Detector[];
  private readonly entropy: NonNullable<RedactionConfig['entropy']>;

  constructor(private readonly config: RedactionConfig) {
    const disabled = new Set(config.disabled);
    this.detectors = DETECTORS.filter((d) => !disabled.has(d.name));

    for (const source of config.extraPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(source, 'g');
      } catch (err) {
        throw new Error(`Invalid extraPatterns regex "${source}": ${(err as Error).message}`);
      }
      this.detectors.push({ name: `custom:${source}`, regex });
    }

    this.entropy = config.entropy!;
  }

  /** Redact one string, interning every candidate into the vault. */
  redactText(text: string, vault: Vault): { text: string; hits: RedactionHit[] } {
    if (!this.config.enabled) return { text, hits: [] };
    if (text.length < this.config.minLength) return { text, hits: [] };

    const ranges = this.collectRanges(text);
    if (ranges.length === 0) return { text, hits: [] };

    const hits: RedactionHit[] = [];
    let out = '';
    let cursor = 0;

    for (const range of ranges) {
      if (range.start < cursor) continue;
      const secret = text.slice(range.start, range.end);
      const placeholder = vault.intern(secret);
      hits.push({ detector: range.detector, length: secret.length, placeholder });
      out += text.slice(cursor, range.start) + placeholder;
      cursor = range.end;
    }
    out += text.slice(cursor);
    return { text: out, hits };
  }

  /** Structural redaction over a JSON-compatible tree. Object keys are preserved. */
  redactDeep<T>(value: T, vault: Vault, hits: RedactionHit[] = []): RedactResult<T> {
    if (!this.config.enabled) return { value, hits };
    if (typeof value === 'string') {
      const r = this.redactText(value, vault);
      hits.push(...r.hits);
      return { value: r.text as unknown as T, hits };
    }
    if (value === null || typeof value !== 'object') return { value, hits };
    if (Array.isArray(value)) {
      const arr = value.map((v) => this.redactDeep(v, vault, hits).value);
      return { value: arr as unknown as T, hits };
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { value, hits };

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = this.redactDeep(v, vault, hits).value;
    }
    return { value: out as unknown as T, hits };
  }

  private collectRanges(text: string): Range[] {
    const ranges: Range[] = [];

    for (const detector of this.detectors) {
      detector.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = detector.regex.exec(text)) !== null) {
        if (match[0].length === 0) {
          detector.regex.lastIndex += 1;
          continue;
        }
        let start: number;
        let end: number;
        if (detector.group !== undefined) {
          const captured = match[detector.group];
          if (captured === undefined) continue;
          const offset = match[0].indexOf(captured);
          if (offset < 0) continue;
          start = match.index + offset;
          end = start + captured.length;
        } else {
          start = match.index;
          end = start + match[0].length;
        }
        if (end - start >= this.config.minLength) {
          ranges.push({ start, end, detector: detector.name });
        }
      }
    }

    if (this.entropy.enabled) {
      ranges.push(...this.entropyRanges(text));
    }

    return mergeRanges(ranges);
  }

  private entropyRanges(text: string): Range[] {
    const out: Range[] = [];
    const candidate = /[A-Za-z0-9+=_-]{1,}/g;
    let match: RegExpExecArray | null;

    while ((match = candidate.exec(text)) !== null) {
      const token = match[0];
      if (token.length < this.entropy.minLength) continue;
      if (looksBenign(token, this.entropy.skipPureHexLengths)) continue;
      if (shannonEntropy(token) < this.entropy.threshold) continue;
      out.push({ start: match.index, end: match.index + token.length, detector: 'entropy' });
    }
    return out;
  }
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (!last || r.start >= last.end) {
      merged.push(r);
      continue;
    }
    // Overlap: keep the wider span so we never emit two nested placeholders.
    if (r.end > last.end) last.end = r.end;
  }
  return merged;
}

/**
 * Reject candidates that are almost certainly identifiers rather than secrets.
 * Pure hex of common digest lengths, words, and path-shaped strings are out.
 */
function looksBenign(token: string, pureHexLengths: number[]): boolean {
  if (/^[0-9a-f]+$/.test(token) && pureHexLengths.includes(token.length)) return true;
  if (/^[A-Za-z]+$/.test(token)) return true;
  if (/^\d+$/.test(token)) return true;

  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasSymbol = /[+/=_-]/.test(token);

  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes < 3) return true;

  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  let entropy = 0;
  const len = value.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
