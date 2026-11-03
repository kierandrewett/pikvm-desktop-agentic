# Model picker, model browser and the settings model selectors
# (components/model-picker, components/model-browser, components/settings/models.tsx, role-models.tsx).
# Model, provider and vendor names are data. They are passed as variables and never translated.

# Shared

# $count is a number.
models-count =
    { $count ->
        [one] { $count } model
       *[other] { $count } models
    }
models-current = Current model
models-favorites = Favorites
models-favorite-add = Add to favorites
models-favorite-remove = Remove from favorites
models-vendors = Vendors
models-providers = Providers
models-group-by = Group models by
models-group-by-vendor = Group by vendor
models-group-by-provider = Group by provider
models-no-models-title = No models yet
models-error-title = Could not load models
models-legacy = Legacy
# $name is a group or vendor name, $count is a model count already formatted, for example "12 models"
models-rail-entry = { $name } · { $count }
# $name is a group or vendor name, $count is a model count already formatted, for example "12 models"
models-rail-entry-aria = { $name }, { $count }
models-hint-choose = choose
models-hint-pick = pick
models-hint-favorite = favorite
# Name of the Enter key
models-key-enter = Enter

# Formatting helpers (components/model-picker/models.ts)

# $count is a number of thousands of tokens, for example 128 for "128K".
models-token-thousands = { $count }K
# $count is a number of millions of tokens, for example 1.5 for "1.5M".
models-token-millions = { $count }M
models-cost-free = Free
# $model, $vendor and $provider are names
models-identity-label-same = { $model }, by { $vendor }
models-identity-label-via = { $model }, by { $vendor }, via { $provider }
models-identity-label-unknown = { $model }, vendor unknown, via { $provider }
models-identity-byline-via = { $vendor } via { $provider }
models-identity-byline-unknown = Vendor unknown, via { $provider }
models-byline-via = via { $provider }

# Model facts (hover card and detail pane)
models-input-text = Text
models-input-vision = Vision
models-input-images = Images
models-input-audio = Audio
models-input-video = Video
models-input-pdf = PDF
models-fact-context = Context
models-fact-output = Output
models-fact-price = Price
models-fact-inputs = Inputs
models-fact-thinking = Thinking
models-fact-tools = Tools
models-fact-released = Released
models-fact-knowledge = Knowledge
# $count is a token count already formatted, for example "128K"
models-fact-tokens = { $count } tokens
# $in and $out are prices already formatted, for example "$3"
models-fact-price-split = { $in } in, { $out } out per 1M
models-fact-thinking-built-in = Built in
models-fact-thinking-none = None
models-fact-yes = Yes
models-fact-no = No

# Model picker (composer)
models-picker-trigger-label = Model: { $label }
models-picker-select = Select model
models-picker-add = Add a model
models-picker-loading = Loading models
models-picker-sheet-title = Model
models-picker-search = Search models
models-picker-list = Models
models-picker-recent = Recent
models-picker-unavailable = Unavailable
models-picker-no-favorites-title = No favorites yet
# $shortcut is a key combination, for example "Ctrl+D"
models-picker-no-favorites-text = Star a model, or press { $shortcut } on it, to keep it here.
models-picker-empty-description = Add a model provider in Settings, and its models show up here.
models-picker-add-provider = Add a provider
# $query is text typed by the person
models-picker-no-match = No models match "{ $query }"
models-picker-no-match-hint = Try a vendor name or fewer words.
models-picker-no-group = No models in this group
models-picker-older = Older models
models-picker-favorite-note = { $byline } · Favorite

# Model browser
models-browser-list = Models
models-browser-search-default = Search models
# $label is the name of the list in lower case, for example "model features"
models-browser-search = Search { $label }
models-browser-search-placeholder = Search by name, id or vendor
models-browser-general = General
models-browser-all = All models
models-browser-filters = Filters
models-browser-filter-reasoning = Reasoning
models-browser-filter-vision = Vision
models-browser-filter-tools = Tools
models-browser-filter-free = Free
models-browser-filter-enabled = Enabled
models-browser-filter-changed = Changed
models-browser-group-vendor = Vendor
models-browser-group-provider = Provider
models-browser-select-model = Select { $name }
models-browser-current-choice = Current choice
models-browser-back = Back to models
models-browser-details = { $name } details
models-browser-details-default = Details
models-browser-about = About this model
models-browser-nothing-title = Nothing selected
models-browser-nothing-description = Choose a model to see its settings.
models-browser-error-title = Could not load the models
models-browser-empty-description = Connect a provider to see its models here.
# $query is text typed by the person
models-browser-no-match = No models match "{ $query }"
models-browser-no-favorites = No favorites yet
models-browser-no-filter-match = No models match these filters
models-browser-no-favorites-hint = Star a model to keep it here.
models-browser-no-match-hint = Try fewer words, another vendor, or clear the filters.
models-browser-clear-filters = Clear search and filters
# $count is a number
models-browser-selected =
    { $count ->
        [one] { $count } selected
       *[other] { $count } selected
    }
# $scope is a model count already formatted, for example "12 models"
models-browser-select-all = Select all { $scope }
models-browser-clear = Clear
models-browser-bulk-failed = Could not update models
# $label is the action text, for example "Turn on 3 models"
models-browser-bulk-title = { $label }?
# $count is a number, $names is a list of model names
models-browser-bulk-description =
    { $count ->
        [one] This changes { $count } model: { $names }.
       *[other] This changes { $count } models: { $names }.
    }
# $names is a list of model names, $count is the number of further models
models-browser-bulk-more = { $names } and { $count } more

# Settings model selector (components/settings/models.tsx)
models-select-automatic = Automatic
models-select-automatic-description = Chat chooses a model for you
models-select-unlisted = Not in the model list
models-select-custom = Use a model not in the list
models-select-custom-format = Use the form provider/model, for example my-provider/my-model.
models-select-custom-label = Model id as provider/model. The provider must accept this id.
models-select-custom-use = Use

# Model role rows (components/settings/role-models.tsx)
# $model is a model name. $from is the role that Automatic resolved to.
models-role-auto =
    { $from ->
        [smol] Automatic uses the Fast model: { $model }.
        [slow] Automatic uses the Thinking model: { $model }.
        [tiny] Automatic uses the Small tasks model: { $model }.
        [memory] Automatic uses the Small tasks model: { $model }.
        [decisions] Automatic uses the Decisions model: { $model }.
       *[default] Automatic uses the default model: { $model }.
    }
models-role-auto-chat = Automatic uses the chat's model.
# $value is a model id. $auto is a full sentence.
models-role-unavailable = { $value } is not available to you. { $auto }
models-role-next = Uses the next model in line
models-decisions-off = Off
models-decisions-off-description = No decisions model. Features that ask use their own rules.
# $value is a model id.
models-decisions-unavailable = { $value } is not available to you. Decisions are off.
models-decisions-list-failed = Could not list { $provider }: { $message }
# Failure toast when the model list cannot be loaded or updated. The error text is its description.
models-load-failed = Could not update models
