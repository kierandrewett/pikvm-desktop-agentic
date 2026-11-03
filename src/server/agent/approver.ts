import type { Approver } from "@pikvm/mcp";

/**
 * The approver a host without a chat to ask in uses: it refuses everything that would ask.
 * Nothing waits on a person who is not there, and a risky action is never done unasked.
 *
 * Chat's own approver (its elicitation in the thread) comes from the chat server and replaces this.
 */
export const unavailableApprover: Approver = {
    async ask() {
        return "unavailable";
    },
};
