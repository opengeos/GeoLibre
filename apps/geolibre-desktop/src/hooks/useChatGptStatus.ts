import { useSyncExternalStore } from "react";
import {
  getChatGptStatus,
  subscribeChatGptStatus,
  type ChatGptStatus,
} from "../lib/assistant/chatgpt";

/**
 * The ChatGPT sign-in status, loaded from the desktop backend on first use and
 * updated on every sign-in and sign-out.
 *
 * @returns The current status.
 */
export function useChatGptStatus(): ChatGptStatus {
  return useSyncExternalStore(subscribeChatGptStatus, getChatGptStatus, getChatGptStatus);
}
