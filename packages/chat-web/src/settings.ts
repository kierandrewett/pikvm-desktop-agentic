/**
 * The settings kit for a host app: the same rows, cards, switches, selects, sheets and navigation Chat's own Settings
 * is built from, without the conversation pane. The host draws its Settings pages with these inside <SettingsScope>
 * (the scope carries the tokens and utilities; see ChatScope for the pane that adds the chat server). The kit is
 * documented in components/settings/kit/index.ts; its declaration for the host's stricter TypeScript settings is
 * ../settings.d.ts.
 */

export { KitScope as SettingsScope, type KitScopeProps as SettingsScopeProps } from "./pane/kit-scope";
export {
    AdvancedSection,
    Badge,
    Button,
    Checkbox,
    DangerZone,
    EmptyState,
    fieldClass,
    FormField,
    IconButton,
    Input,
    LinkRow,
    NumberField,
    Notice,
    Segmented,
    Select,
    SettingRow,
    SettingsCard,
    SettingsChrome,
    SettingsPage,
    SettingsSection,
    Spinner,
    Switch,
    TextArea,
    TextField,
    type Option,
    type PageAction,
} from "./components/settings/kit";
export {
    SettingsNavFrame,
    SettingsNavItem,
    SettingsNavList,
    SettingsNavSection,
    type SettingsNavLinkProps,
} from "./components/settings/nav";
export { ConfirmDialog, Dialog } from "./components/ui/dialog";
export { Sheet } from "./components/ui/sheet";
export { toast } from "./components/ui/toast";
