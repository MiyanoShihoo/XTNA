export type PanelQueryVerdict =
  | {
      readonly ok: true;
      readonly tool: string;
      readonly args: Readonly<Record<string, string | number | boolean | null>>;
    }
  | { readonly ok: false; readonly reason: string };

export const DEFAULT_READ_ONLY_TOOLS: readonly string[];

export function validatePanelQuery(
  payload: unknown,
  options?: { readonly allowedTools?: readonly string[] },
): PanelQueryVerdict;

export function parseToolList(value: string | undefined): string[] | undefined;
