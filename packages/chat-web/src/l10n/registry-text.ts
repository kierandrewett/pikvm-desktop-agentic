/**
 * Connects the settings registry (components/settings/registry.ts, plain data that scripts import) to Fluent.
 * The registry asks for the message `settingsMessageId()` names; a missing message falls back to the English text.
 * Imported once by provider.tsx.
 */
import { setSettingsTextResolver } from "../components/settings/registry";
import { translate } from "./runtime";

setSettingsTextResolver((id, english) => {
    const text = translate(id);
    return text === id ? english : text;
});
