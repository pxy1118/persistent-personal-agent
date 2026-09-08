import type { StopReasonType } from "@/types/protocol_v2";
import { TO_SUBSCRIBERS } from "./connection";
import {
  emitInterruptedStatusDelta,
  emitProtocolV2Message,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

export function finishListenerTurn(
  runtime: ConversationRuntime,
  lease: TurnLease,
  options: {
    stopReason: StopReasonType;
    socket?: ListenerTransport;
    runId?: string | null;
    agentId?: string | null;
    conversationId: string;
    turnId?: string;
    error?: string;
    /** Delay the terminal frame until async turn cleanup has completed. */
    deferTerminal?: (emit: () => void) => void;
  },
): TurnFinishTransition {
  const transition = runtime.turnLifecycle.finish(lease, options.stopReason);
  if (!transition.finished) {
    return transition;
  }

  // Explicit abort projects the interrupted state when it moves the lease to
  // cancelling. Only server-originated cancellation reaches finish from active.
  if (
    options.stopReason === "cancelled" &&
    transition.previousKind === "active" &&
    options.socket
  ) {
    emitInterruptedStatusDelta(options.socket, runtime, {
      runId: options.runId ?? transition.runId,
      agentId: options.agentId,
      conversationId: options.conversationId,
    });
  }

  if (transition.previousKind === "active") {
    emitRuntimeStateUpdates(runtime, {
      agent_id: options.agentId ?? null,
      conversation_id: options.conversationId,
    });
  }
  if (options.socket && options.turnId) {
    const emit = () =>
      emitProtocolV2Message(
        options.socket!,
        runtime,
        {
          type: "turn_finished",
          turn_id: options.turnId!,
          stop_reason: options.stopReason,
          ...((options.runId ?? transition.runId)
            ? { run_id: options.runId ?? transition.runId ?? undefined }
            : {}),
          ...(options.error ? { error: options.error } : {}),
        },
        {
          agent_id: options.agentId,
          conversation_id: options.conversationId,
        },
        TO_SUBSCRIBERS,
      );
    if (options.deferTerminal) options.deferTerminal(emit);
    else emit();
  }
  return transition;
}
