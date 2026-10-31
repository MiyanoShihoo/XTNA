export const PANEL_CONTRACT_VERSION: string;

export interface PanelContractDescription {
  readonly version: string;
  readonly state: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
    readonly counts: readonly string[];
    readonly graph: readonly string[];
    readonly waterfall: readonly string[];
  };
  readonly query: Record<string, unknown>;
  readonly changePolicy: string;
}

export function validatePanelState(snapshot: unknown): string[];
export function validateQueryRequestShape(payload: unknown): string[];
export function validateQueryResponseShape(payload: unknown): string[];
export function panelContract(): PanelContractDescription;
