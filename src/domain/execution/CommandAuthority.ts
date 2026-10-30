export type CommandAuthority = "read-only" | "write" | "destructive";
export type CommandTier = "L1" | "L2" | "L3";

export interface CommandRequest {
  readonly operation: string;
  readonly authority: CommandAuthority;
  readonly approved?: boolean;
  readonly dryRun?: boolean;
  /** L2 work must be admitted to an isolated environment. */
  readonly sandboxed?: boolean;
  /** L3 work must show a reviewable change before approval. */
  readonly diffPreview?: string;
}

export type CommandDecision =
  | {
      readonly allowed: true;
      readonly executed: boolean;
      readonly tier: CommandTier;
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly executed: false;
      readonly tier: CommandTier;
      readonly reason: string;
    };

const tierOf = (authority: CommandAuthority): CommandTier =>
  authority === "read-only" ? "L1" : authority === "write" ? "L2" : "L3";

/** Every side effect is explicit; a dry run never grants authority. */
export const authorizeCommand = (request: CommandRequest): CommandDecision => {
  const tier = tierOf(request.authority);
  if (request.authority === "read-only")
    return {
      allowed: true,
      executed: !request.dryRun,
      tier,
      reason: request.dryRun
        ? "L1 read-only dry run."
        : "L1 read-only operation.",
    };
  if (request.dryRun)
    return {
      allowed: true,
      executed: false,
      tier,
      reason: `${tier} operation planned; not executed.`,
    };
  if (request.authority === "write" && request.sandboxed !== true)
    return {
      allowed: false,
      executed: false,
      tier,
      reason: "L2 write requires an isolated sandbox admission.",
    };
  if (request.authority === "destructive" && request.approved !== true)
    return {
      allowed: false,
      executed: false,
      tier,
      reason: "L3 destructive operation requires explicit approval.",
    };
  if (
    request.authority === "destructive" &&
    (request.diffPreview === undefined ||
      request.diffPreview.trim().length === 0)
  )
    return {
      allowed: false,
      executed: false,
      tier,
      reason: "L3 destructive operation requires a non-empty diff preview.",
    };
  return {
    allowed: true,
    executed: true,
    tier,
    reason: `${tier} operation explicitly approved.`,
  };
};
