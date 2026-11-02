export { AiAssistant } from './assistant.js';
export { MemoryAuditSink, auditSubject } from './audit.js';
export { AiError, type AiErrorCode } from './errors.js';
export { AI_OPTIONS, AiModule, type AiModuleAsyncOptions } from './module.js';
export {
  TestProvider,
  type TestRule,
  type TestProviderOptions,
} from './test-provider.js';
export type {
  AiApprovalResult,
  AiAssistantOptions,
  AiAuditEvent,
  AiAuditSink,
  AiAuditType,
  AiConversationView,
  AiJson,
  AiMessageView,
  AiOutcome,
  AiPendingView,
  AiStatus,
  AiStreamOptions,
  AiTool,
  AiToolContext,
  AiToolStatus,
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatStreamOptions,
  ToolSpec,
} from './types.js';
import type { AiTool } from './types.js';

/** Identity helper that preserves the argument type of a tool definition. */
export function defineTool<Args>(tool: AiTool<Args>): AiTool<Args> {
  return tool;
}
