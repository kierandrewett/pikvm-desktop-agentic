/**
 * Settings kit: the one set of components every settings page is built from.
 *
 * Usage
 *
 *     <SettingsPage title="Appearance">
 *         <SettingsSection title="Visual style" description="Optional help line.">
 *             <SettingsCard>
 *                 <KeyRow k="ui.density" label="Density" />                      // bound to a user key
 *                 <SettingRow id="mode" label="Mode" control={<Segmented ... />} /> // any control
 *                 <LinkRow label="Model providers" onClick={...} />               // opens something
 *             </SettingsCard>
 *         </SettingsSection>
 *         <AdvancedSection>
 *             <SettingsCard><RawKeyRow k="ui.files.view" /></SettingsCard>
 *         </AdvancedSection>
 *     </SettingsPage>
 *
 * Rules
 * - Rows: SettingRow (or KeyRow / AdminKeyRow / RawKeyRow / SecretRow, which render one). No other row markup.
 *   Give every row an `id` (KeyRow uses the setting key) so search and deep links (`#id`) can reach it.
 * - Controls inside rows are the 28px family (`sm`); forms and page actions use `md` (36px). Never size by hand.
 * - Primary actions: one `Button variant="primary"` per view. Destructive actions: `variant="danger"` and a confirm.
 * - Empty, loading and error content inside a card: EmptyState. Section-wide messages: Notice. Row status: the
 *   row's `status` (KeyRow does this for you).
 * - Locks: pass `lock` to the row; it shows a lock icon with the reason as a tooltip and disables every kit control in
 *   the row (see lock.ts). Bound rows also disable when the binding is not writable. Only a custom control that is
 *   not from this kit needs its own `disabled`.
 * - Colours come from tokens; sizes from spacing utilities, so density and roundness apply everywhere.
 * - Search: the results page (`/settings/search`) renders pages inside `SettingsSearchScope`. The kit hides rows,
 *   cards and sections that do not match and marks matched words in kit text, so pages need no search code.
 *   Text rendered outside the kit is not marked; a row without a registry `id` shows only when its section
 *   heading or page title matches.
 * - Page header actions: `actions` is a list of PageAction (label, icon, onSelect). The header shows one icon
 *   button with a tooltip, or one "More actions" menu for several. No text buttons in the header.
 * - Phones and narrow windows: the kit adapts rows from the settings column width (settings.css). A custom control
 *   that needs room marks itself `data-wide` (full width under the label); a value picker uses Select. Pages need
 *   no layout code of their own.
 */
export {
    AdvancedSection,
    DangerZone,
    Described,
    FormField,
    HostDrawsTitle,
    LinkRow,
    LockMark,
    SettingRow,
    SettingsCard,
    SettingsCardMedia,
    SettingsChrome,
    SettingsPage,
    SettingsSection,
    secondaryText,
    useRowAnchor,
    type Lock,
    type PageAction,
} from "./layout";
export {
    Checkbox,
    ColorField,
    fieldClass,
    flushEditor,
    fromPairs,
    Input,
    KeyValueList,
    ListEditor,
    normaliseHex,
    NumberField,
    PickerTrigger,
    Segmented,
    Select,
    Slider,
    Switch,
    TextArea,
    TextField,
    toPairs,
    type FieldSize,
    type Option,
    type Pairs,
    type PickerTriggerProps,
    type TextFieldProps,
} from "./controls";
export {
    Badge,
    Button,
    EmptyState,
    IconButton,
    IconTile,
    InlineStatus,
    Notice,
    Spinner,
    useSaveStatus,
    type BadgeTone,
    type ButtonProps,
    type ButtonSize,
    type ButtonVariant,
    type NoticeTone,
    type Status,
} from "./feedback";
export {
    AdminKeyRow,
    AdminObjectRows,
    BoundRow,
    BytesField,
    humanise,
    KeyRow,
    kindOf,
    RawKeyRow,
    renderControl,
    UserObjectRows,
    type BoundRowProps,
    type ControlSpec,
    type Kind,
    type ObjectField,
} from "./bound";
export { RowLockContext, useRowLocked } from "./lock";
export { row } from "../registry";
export { SecretRow } from "./secret";
export { SearchMark, useSearchScope, type SearchScope } from "./search";
export { erase, errorText, fieldBinding, useAdminSetting, useUserSetting, type Binding } from "../bindings";
