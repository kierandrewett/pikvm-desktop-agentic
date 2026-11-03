/** Re-export of the shared package (@chat/ui). Kept so existing import sites compile; import from @chat/ui in new code. */
export {
    findMatch,
    matchLabel,
    typeaheadChar,
    useTypeahead,
    type LabelMatch,
    type MatchRange,
    type Typeahead,
    type TypeaheadHit,
} from "../ui/index";
