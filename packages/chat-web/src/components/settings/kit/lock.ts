/**
 * Row lock context. A SettingRow with a `lock` provides `true` around its control. Every kit control reads it, so a
 * locked row disables Switch, Select, Segmented, fields, sliders, lists and key/value lists without the page passing
 * `disabled` by hand. A control's own `disabled` prop still works; the two combine with "or".
 */
import { createContext, useContext } from "react";

export const RowLockContext = createContext(false);

/** The control's own `disabled`, or true when the row around it is locked. */
export function useRowLocked(own?: boolean): boolean {
    const locked = useContext(RowLockContext);
    return locked || !!own;
}
