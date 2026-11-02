import { createContext, useContext } from "react";

/**
 * Whether the pending approval is being answered in the dock above the composer.
 *
 * On a phone the card inside a long thread can be scrolled out of reach exactly when
 * the agent is waiting on it, so the answer lives in a bar that is always on screen.
 * While it does, the card shows what is being asked but not a second set of buttons:
 * one place to answer, so a thumb never has to choose between two Allows.
 */
const ApprovalDockedContext = createContext(false);

export const ApprovalDockedProvider = ApprovalDockedContext.Provider;

export const useApprovalDocked = () => useContext(ApprovalDockedContext);
