export type CommandAuthority = "read-only" | "write" | "destructive";

export interface CommandRequest {
  readonly operation: string;
  readonly authority: CommandAuthority;
  readonly approved?: boolean;
  readonly dryRun?: boolean;
}

export type CommandDecision =
  | { readonly allowed: true; readonly executed: boolean; readonly reason: string }
  | { readonly allowed: false; readonly executed: false; readonly reason: string };

/** Every side effect is explicit; a dry run never grants authority. */
export const authorizeCommand = (request: CommandRequest): CommandDecision => {
  if (request.authority === "read-only")
    return { allowed: true, executed: !request.dryRun, reason: request.dryRun ? "Read-only dry run." : "Read-only operation." };
  if (request.dryRun)
    return { allowed: true, executed: false, reason: `${request.authority} operation planned; not executed.` };
  if (request.approved !== true)
    return { allowed: false, executed: false, reason: `${request.authority} operation requires explicit approval.` };
  return { allowed: true, executed: true, reason: `${request.authority} operation explicitly approved.` };
};
