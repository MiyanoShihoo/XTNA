export type PanelQueryVerdict =
  | {
      readonly ok: true;
      readonly tool: string;
      readonly tier: "read" | "write" | "attach";
      readonly args: Readonly<Record<string, string | number | boolean | null>>;
    }
  | { readonly ok: false; readonly reason: string };

export const DEFAULT_READ_ONLY_TOOLS: readonly string[];

export const TOOL_TIERS: Readonly<Record<string, "write" | "attach">>;

export function validatePanelQuery(
  payload: unknown,
  options?: {
    readonly allowedTools?: readonly string[];
    readonly allowWriteTools?: readonly string[];
  },
): PanelQueryVerdict;

export function parseToolList(value: string | undefined): string[] | undefined;
