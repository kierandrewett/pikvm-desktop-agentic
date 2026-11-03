# Settings > Integrations: model providers, MCP servers and sign-in providers.
# Provider names, server names, tool names and URLs are data and are never translated.

integrations-auth-tenant = Tenant id
integrations-auth-tenant-help = Leave empty for any work, school or personal account (common).
integrations-auth-domain = Domain
integrations-auth-domain-help = For example your-pool.auth.eu-west-2.amazoncognito.com
integrations-auth-region = Region
integrations-auth-region-help = For example eu-west-2
integrations-auth-pool = User pool id
integrations-auth-copy-callback = Copy callback URL
integrations-auth-callback = Callback URL
# $provider is a provider name
integrations-auth-callback-help = Paste this into the { $provider } app as the callback URL.
integrations-auth-callback-help-generic = Paste this into the provider app as the callback URL.
integrations-auth-title = Sign-in providers
integrations-auth-description = Each one adds a button to the sign-in page.
integrations-auth-none = None yet. People sign in with email and password or a passkey.
integrations-auth-oidc = OpenID Connect
integrations-auth-enabled = { $name } enabled
integrations-auth-client-id-value = Client id { $id }
integrations-auth-add = Add a sign-in provider
integrations-auth-authentication = Authentication
integrations-auth-sso = Single sign-on
integrations-auth-oidc-help = Your own identity provider, such as Keycloak.
integrations-auth-social = Social accounts
# $host is a website host name
integrations-auth-credentials-from = Credentials from { $host }
integrations-auth-sign-in-with = Sign in with { $name }
integrations-auth-unsupported = This provider is not supported.
integrations-auth-enter-client-id = Enter the client id.
integrations-auth-fill-all = Fill in every field that is not optional.
integrations-auth-check-details = Check the details
integrations-auth-add-social = Add { $name } sign-in
integrations-auth-no-public-url = The public URL is not set in System, so the callback URL below uses this browser's address.
integrations-auth-step-create = 1. Create an app at { $name }
integrations-auth-dev-settings = Developer settings
integrations-auth-create-oauth = Create an OAuth app at { $host }.
integrations-auth-get-credentials = Get credentials
integrations-auth-step-paste-credentials = 2. Paste its credentials
integrations-auth-client-id = Client id
integrations-auth-client-secret = Client secret
integrations-auth-add-named = Add { $name }
integrations-auth-enter-label = Enter a button label.
integrations-auth-enter-discovery = Enter the discovery URL.
integrations-auth-add-oidc = Add OpenID Connect sign-in
integrations-auth-step-name = 1. Name it
integrations-auth-button-label = Button label
integrations-auth-button-label-help = Shown on the sign-in page, for example Company SSO.
integrations-auth-step-register = 2. Register this app with your identity provider
integrations-auth-step-paste-details = 3. Paste its details
integrations-auth-discovery = Discovery URL
integrations-auth-discovery-help = The address of its .well-known/openid-configuration document.
integrations-auth-client-secret-help = Leave empty for public clients that use PKCE only.
integrations-auth-remove-help = Its button leaves the sign-in page. People who used it need another way to sign in.
integrations-auth-remove-confirm = Its client id and secret are deleted.
integrations-auth-gone = This provider is not set up any more.
integrations-auth-show = Show on the sign-in page
integrations-auth-on = On
integrations-auth-scopes = Scopes
integrations-auth-scopes-help = Empty uses the provider's defaults.
integrations-auth-options = Options
integrations-auth-options-help = Provider-specific settings, for example tenantId for Microsoft.
integrations-auth-options-save = Save options
integrations-auth-pkce = PKCE
integrations-auth-pkce-help = Recommended. Turn off only if your provider lacks support.
integrations-auth-pkce-use = Use PKCE
integrations-auth-prompt = Prompt
integrations-auth-prompt-help = Show a login or account picker every time.
integrations-auth-prompt-default = Provider default
integrations-auth-params = Extra authorisation parameters
integrations-auth-params-help = Extra parameters added to the sign-in redirect.
integrations-auth-params-list = Authorisation parameters
integrations-auth-params-save = Save parameters

integrations-add = Add
integrations-version = Version
integrations-status = Status
integrations-mcp-connected = Connected
integrations-mcp-signin-unfinished = Sign-in did not finish
integrations-mcp-needs-signin = Needs sign-in
integrations-mcp-needs-attention = Needs attention
integrations-mcp-cat-developer = Developer
integrations-mcp-cat-productivity = Productivity
integrations-mcp-cat-knowledge = Knowledge
integrations-mcp-cat-data = Data
integrations-mcp-cat-communication = Communication
integrations-mcp-cat-design = Design
integrations-mcp-cat-utilities = Utilities
integrations-mcp-not-allowed = Your administrator has not allowed this server.
integrations-mcp-locked = Locked
integrations-mcp-catalogue-loading = Loading the catalog
integrations-mcp-search = Search servers
integrations-mcp-gallery-empty = Nothing matches "{ $query }". Try another name, or add a custom server below.
integrations-mcp-featured = Featured
integrations-mcp-custom = Custom server
integrations-mcp-custom-help = Any MCP server by URL, or a command that runs in your sandbox
integrations-mcp-looking = Looking at the server
integrations-mcp-check-failed = Could not check the server: { $error }
integrations-mcp-not-mcp = The server did not answer as an MCP server.
integrations-mcp-server-fallback = MCP server
integrations-mcp-version = Version { $version }
integrations-mcp-stateless = Stateless protocol
integrations-mcp-stateful = Stateful protocol
integrations-mcp-signin-needed = Sign-in needed (OAuth)
integrations-mcp-reachable = Reachable
integrations-mcp-expiry-unknown = not stated
# $when is a relative time such as "4 min ago"
integrations-mcp-expiry-ended = ended { $when }
# $when is a date and time
integrations-mcp-expiry-ends = ends { $when }
integrations-mcp-reconnect = Reconnect
integrations-mcp-signin = Sign-in
integrations-mcp-signin-ended = The sign-in ended. Reconnect to use this server again.
integrations-mcp-more-access = The server asked for more access. Reconnect to allow it.
# $scopes is a list of OAuth scopes
integrations-mcp-more-access-scopes = The server asked for more access: { $scopes }. Reconnect to allow it.
integrations-mcp-disconnect = Disconnect
integrations-mcp-account = Account
integrations-mcp-access-granted = Access granted
integrations-mcp-no-scopes = The server did not list scopes.
integrations-mcp-signed-in = Signed in
integrations-mcp-tokens-note = Tokens stay on the Chat server.
integrations-mcp-badge-read-only = Read only
integrations-mcp-badge-destructive = Can delete data
integrations-mcp-badge-idempotent = Idempotent
integrations-mcp-badge-open-world = Reaches outside services
integrations-mcp-binary = This resource is binary and has no preview.
integrations-mcp-prompts = Prompts
# $id is a server id
integrations-mcp-prompts-help = Use them in a chat as /{ $id }:<prompt> slash commands.
integrations-mcp-resources = Resources
integrations-mcp-resources-help = Documents the server can share. Preview them here.
integrations-mcp-preview = Preview
integrations-mcp-copy-ref = Copy reference for { $name }
integrations-mcp-preview-of = Preview of { $uri }
integrations-mcp-permissions = Permissions
integrations-mcp-granted = Granted
integrations-mcp-none-listed = None listed
integrations-mcp-not-granted = Asked for, not granted
integrations-mcp-not-granted-help = Reconnect to allow these.
integrations-mcp-information = Information
integrations-mcp-protocol = Protocol
integrations-mcp-disconnect-named = Disconnect { $name }?
integrations-mcp-disconnect-help = The saved sign-in is deleted. You can connect again later.
integrations-mcp-publisher = Publisher
integrations-mcp-website = Website
integrations-mcp-privacy = Privacy policy
integrations-mcp-note = Note
integrations-mcp-about = About this server

integrations-mcp-tools =
    { $count ->
        [one] { $count } tool
       *[other] { $count } tools
    }

# Shared parts of the model provider and MCP server pages.

integrations-input-get-key = Get a key
integrations-input-find-it = Where to find it
integrations-input-optional = (optional)
# $value is a number of seconds
integrations-seconds = { $value } s
# $value is a number of milliseconds
integrations-latency-ms = { $value } ms
# $value is a number of seconds with one decimal place
integrations-latency-s = { NUMBER($value, minimumFractionDigits: 1, maximumFractionDigits: 1) } s
integrations-check-slow = Still waiting for an answer. A slow server can take up to 15 seconds before this stops.
integrations-check-found = Found
integrations-items-more = { $count } more
integrations-copy = Copy
integrations-copied = Copied
integrations-search = Search

# MCP settings
integrations-approvals-title = Tool approvals
integrations-approvals-trust-label = Trust read-only tool annotations
integrations-approvals-trust-title = Trust server tool annotations?
integrations-approvals-trust-description = A remote server can claim that a tool only reads data. This setting lets such tools run without asking, unless they are also marked destructive or a per-tool policy requires approval. Only enable it for servers you trust.
integrations-approvals-trust-confirm = Trust annotations
integrations-approvals-destructive-label = Confirm destructive tools
integrations-approvals-destructive-title = Stop requiring destructive-tool approval?
integrations-approvals-destructive-description = Tools marked destructive will follow the chat permission mode and per-tool policies instead of always asking. With full access, they may run without approval. Integration approval rules still apply.
integrations-approvals-destructive-confirm = Change approval policy
integrations-personal-servers = Personal servers
integrations-private-label = Allow private network access
integrations-private-title = Allow access to private services?
integrations-private-description = User-added MCP servers and OAuth endpoints can reach private, loopback and link-local addresses, including plain HTTP. This can expose services and credentials on the server's network. Leave this off unless you trust every user who can add servers.
integrations-private-confirm = Allow private access
integrations-catalogue = Catalog

# Relative times and the preset gallery
integrations-ago-now = just now
integrations-ago-minutes = { $count } min ago
integrations-ago-hours = { $count } h ago
integrations-gallery-search-providers = Search providers
# $query is what the person typed
integrations-gallery-empty = Nothing matches "{ $query }". Try another name, or add a custom one below.
integrations-gallery-added = Added
# $tag is a short fact such as "Remote"; $description is the preset description
integrations-gallery-tagged = { $tag } · { $description }

integrations-managed = Managed
# $name is a provider, server or model name
integrations-switch-on = { $name } on
integrations-health-off = Off
integrations-health-checking = Checking
integrations-health-unchecked = Not checked yet
integrations-loading = Loading
integrations-loading-dots = Loading
integrations-try-again = Try again
integrations-connect = Connect
integrations-connect-named = Connect { $name }
integrations-not-found = Not found
integrations-could-not-save = Could not save
integrations-check-failed = The check could not run
integrations-open = Open
integrations-docs = Docs
integrations-details = Details
# $label is the lower-case name of a field
integrations-enter-field = Enter the { $label }.
integrations-save-untested = Save without testing
integrations-test-again = Test again
integrations-checking = Checking the connection
integrations-test-connection = Test connection
integrations-connection = Connection
integrations-api-key = API key
integrations-kept-on-server = Kept on the server
integrations-address = Address
integrations-advanced = Advanced
integrations-base-url = Base URL
integrations-default = Default
integrations-none = None
integrations-remove = Remove
integrations-remove-named = Remove { $name }?
integrations-cancel = Cancel
integrations-refresh = Refresh

integrations-mcp-err-oauth-title = This server asks you to sign in (OAuth)
integrations-mcp-err-oauth-fix = Chat cannot sign in to MCP servers yet. If the server also accepts an access token, add it as an Authorization header (Bearer <token>).
integrations-mcp-err-token-title = The server rejected the token
integrations-mcp-err-token-fix = Check the token and its permissions, then try again.
integrations-mcp-err-404-title = No MCP server at this address
integrations-mcp-err-404-fix = Check the URL, including the path. MCP endpoints often end in /mcp or /sse.
integrations-mcp-err-slow-title = The server did not answer in time
integrations-mcp-err-slow-fix = It may be slow or stuck. Try again, or raise the timeout in Advanced.
integrations-mcp-err-command-title = The command is not available in the sandbox
integrations-mcp-err-command-fix = Check the command name, or ask your administrator to install it.
integrations-mcp-err-unreachable-title = Could not reach the server
integrations-mcp-err-unreachable-fix = Check the address. The Chat server makes the connection, not your device.
integrations-mcp-err-generic-title = The server did not start
integrations-mcp-err-generic-fix = Check the settings below and try again.
# $name is a server name
integrations-mcp-connected-to = Connected to { $name }.
integrations-mcp-connected-dot = Connected.
integrations-mcp-no-tools = It offers no tools.
integrations-mcp-tools-label = Tools
integrations-mcp-health-shadowed = Not used: your organization has a server with this name
integrations-mcp-health-starting = Starting and checking
integrations-mcp-transport-stdio = Command in your sandbox
integrations-mcp-transport-sse = Remote, HTTP with SSE
integrations-mcp-transport-http = Remote, Streamable HTTP
integrations-mcp-title = MCP servers
integrations-mcp-add = Add server
integrations-mcp-check-again = Check again
integrations-mcp-policy-paused = Your administrator turned off personal MCP servers. Yours are kept but paused until this is allowed again.
integrations-mcp-policy-blocked = Your administrator does not allow adding your own MCP servers. You can use the ones below.
integrations-mcp-check-servers-failed = Could not check the servers: { $error }
integrations-mcp-org-description = Set up by an administrator for everyone.
integrations-mcp-everyone = Servers for everyone
integrations-mcp-everyone-description = Every user's assistant gets these tools.
integrations-mcp-yours-description = Tools from these servers are available in your chats.
integrations-mcp-loading = Loading servers
integrations-mcp-empty-admin = No servers for everyone yet
integrations-mcp-empty-user = No servers of your own
integrations-mcp-empty-off = Adding MCP servers is turned off for your account.
integrations-mcp-empty-help = An MCP server gives the assistant extra tools, such as reading issues or fetching pages. Pick one below to start.
integrations-mcp-builtin = Built in
integrations-mcp-builtin-help = Part of Chat. Always available to the assistant.
integrations-mcp-not-running = Not running
integrations-mcp-personal-off = Users cannot add their own MCP servers.
integrations-mcp-personal-on = Users can add their own MCP servers.
integrations-mcp-add-title = Add an MCP server

integrations-mcp-tools-available =
    { $count ->
        [one] { $count } tool available.
       *[other] { $count } tools available.
    }

integrations-mcp-health-connected =
    { $count ->
        [one] Connected, { $count } tool
       *[other] Connected, { $count } tools
    }

# $off is the number of turned-off tools
integrations-mcp-health-connected-off =
    { $count ->
        [one] Connected, { $count } tool, { $off } off
       *[other] Connected, { $count } tools, { $off } off
    }

integrations-saving = Saving
integrations-mcp-not-in-catalogue = This server is not in the catalog.
integrations-mcp-already-added = { $name } is already added.
integrations-mcp-enter-url = Enter the server URL.
integrations-mcp-enter-command = Enter the command.
integrations-mcp-enter-name = Enter a name.
integrations-mcp-check-settings = Check the settings.
integrations-mcp-starting-sandbox = Starting in your sandbox. The first start can take a minute to download.
integrations-mcp-still-not-running = Still not running after two minutes
integrations-mcp-still-not-running-fix = It is saved. Open it later to see whether it started.
integrations-mcp-connecting = Connecting to the server
integrations-mcp-add-custom = Add a custom server
integrations-mcp-custom-description = Any MCP server by URL, or a command in your sandbox.
integrations-mcp-how-runs = How it runs
integrations-mcp-how-runs-local = A command started inside your sandbox, like npx or uvx.
integrations-mcp-how-runs-remote = A server you reach by URL. Streamable HTTP and the older SSE transport both work.
integrations-mcp-remote-url = Remote URL
integrations-mcp-command = Command
integrations-mcp-server-url = Server URL
integrations-mcp-server-url-help = For example https://mcp.example.com/mcp. Leave the field to test it.
integrations-mcp-headers-help = Optional. Sent with every request.
integrations-mcp-command-help = For example npx or uvx.
integrations-mcp-arguments = Arguments
integrations-mcp-arguments-help = One per entry, in order.
integrations-mcp-environment = Environment
integrations-mcp-environment-help = Values are stored as secrets.
integrations-mcp-name-help-local = A short unique name, such as github.
integrations-mcp-name-help-remote = Filled in from the server when you test it.
integrations-mcp-nothing-local = Nothing to fill in. It runs as a command in your sandbox, so connecting starts it there.
integrations-mcp-open = Open server
integrations-mcp-add-start = Add and start
integrations-mcp-test-add = Test and add
integrations-mcp-gone = This server is not added any more.
integrations-mcp-starting-it = Starting it in your sandbox
integrations-mcp-managed-note = Set up by your organization. Its secrets stay on the server.
integrations-mcp-shadowed-note = Your organization has a server with the same name, so this one is not used. Remove it, or add it again under another name.
integrations-mcp-use = Use this server
integrations-mcp-runs-as = Runs as
integrations-mcp-url = URL
integrations-mcp-header = Header
integrations-mcp-env-var = Environment variable
integrations-mcp-secrets = Secrets
integrations-mcp-cwd = Working directory
integrations-mcp-transport = Transport
integrations-mcp-transport-help = Testing detects this. Change it only for older servers.
integrations-mcp-timeout = Timeout
integrations-mcp-timeout-help = How long to wait for the server. Empty uses the default.
integrations-mcp-remove = Remove server
integrations-mcp-remove-help = Its settings and secrets are deleted and its tools leave your chats.
integrations-mcp-remove-confirm = Its settings and secrets are deleted. You can add it again later.
integrations-mcp-policy-on = On
integrations-mcp-policy-ask = Ask
integrations-mcp-search-tools = Search tools
integrations-mcp-tools-loading = Starting the server to list its tools
integrations-mcp-tools-none = No tools listed yet. Test the connection to list them.
integrations-mcp-tools-off = Turn the server on to list its tools.
integrations-mcp-tools-no-match = No tools match.
# $tool is a tool name
integrations-mcp-policy-for = Policy for { $tool }
integrations-mcp-asks-first = Asks first
# $count is the next page size; $left is how many are still hidden
integrations-mcp-show-more = Show { $count } more of { $left }
integrations-mcp-add-env = Add an environment variable
integrations-mcp-add-header = Add a header
integrations-mcp-add-secret-help = Stored as a secret and never shown again.
integrations-mcp-value = Value

integrations-mcp-more-tools =
    { $count ->
        [one] And { $count } more tool. All are listed on the server's page after you add it.
       *[other] And { $count } more tools. All are listed on the server's page after you add it.
    }

integrations-mcp-secrets-kept =
    { $count ->
        [one] { $count } value, kept on the server
       *[other] { $count } values, kept on the server
    }

# $parts is a comma-separated list such as "12 tools, 2 off"
integrations-mcp-tools-summary = { $parts }. "On" follows the chat's permission mode, "Ask" asks before every call, "Off" refuses every call.
integrations-mcp-tools-off-count = { $count } off
integrations-mcp-tools-ask-count = { $count } always ask

integrations-prov-err-key-title = The key was rejected
integrations-prov-err-key-fix = Check that you copied the whole key and that it is still active. If in doubt, create a new key.
integrations-prov-err-404-title = No models list at this address
integrations-prov-err-404-fix = Check the base URL. For most APIs it ends in /v1.
integrations-prov-err-429-title = Rate limited or out of credit
integrations-prov-err-429-fix = Check your plan and billing with the provider, then try again.
integrations-prov-err-timeout-title = The server took too long to answer
integrations-prov-err-unreachable-title = Could not reach the server
integrations-prov-err-unreachable-fix = Check the address. The Chat server makes the connection, so localhost means the Chat server itself, not your device.
integrations-prov-err-no-url-title = A base URL is needed
integrations-prov-err-no-url-fix = Enter the address of the API.
integrations-prov-err-generic-title = The connection did not work
integrations-prov-err-generic-fix = Check the details and try again.
integrations-prov-connected = Connected.
integrations-prov-models = Models
integrations-prov-health-shadowed = Not used: your organization has a provider with this id
integrations-prov-health-paused = Paused by your administrator
integrations-prov-health-list-failed = The model list could not load. Try Refresh on this page.
integrations-prov-title = Model providers
integrations-prov-add = Add provider
integrations-prov-policy-paused = Your administrator turned off personal providers. Yours are kept but paused, and their models are hidden until this is allowed again.
integrations-prov-policy-blocked = Your administrator does not allow adding your own providers. You can use the ones below.
integrations-prov-org-title = From your organization
integrations-prov-org-description = Set up by an administrator. Keys stay on the server.
integrations-prov-yours = Yours
integrations-prov-loading = Loading providers
integrations-prov-empty-user = No providers of your own
integrations-prov-empty-off = Adding providers is turned off for your account.
integrations-prov-empty-user-description = Pick one below and paste a key. Its models show up in the model picker.
integrations-prov-group-cloud = Cloud
integrations-prov-group-router = Routers
integrations-prov-group-local = On your own machine
integrations-prov-catalogue-loading = Loading the catalog
# $error is the error text
integrations-prov-catalogue-failed = Could not load the catalog: { $error }
integrations-prov-catalogue-failed-short = Could not load the provider catalog.
integrations-prov-something-else = Something else
integrations-prov-add-title = Add a provider
integrations-prov-not-in-catalogue = This provider is not in the catalog.
integrations-prov-checking-named = Checking the connection to { $name }
integrations-prov-already-connected = { $name } is already connected.
integrations-prov-connect-custom = Connect a custom endpoint
integrations-prov-details-user = Kept on the server and never shown again. Only the assistant's requests use it.
integrations-prov-name-label = Name
integrations-prov-name-help = How it shows in the model picker.
integrations-prov-api-type = API type
integrations-prov-api-type-help = Most self-hosted and gateway APIs use Chat completions.
integrations-prov-nothing-to-fill = Nothing to fill in. Connect to check it works.
integrations-prov-test-connect = Test and connect
integrations-prov-gone = This provider is not connected any more.
integrations-prov-managed-note = Set up by your organization. The key stays on the server.
integrations-prov-shadowed-note = Your organization has a provider with the same id, so this one is not used. Remove it, or add it again under another name.
integrations-prov-use = Use this provider
integrations-prov-key-stored = Stored on the server and never shown again.
integrations-prov-builtin = Built-in
integrations-prov-base-url-help = Leave empty for built-in providers.
integrations-prov-discovery = Model discovery
integrations-prov-discovery-help = How the model list is found when no models are listed by hand.
integrations-prov-remove = Remove provider
integrations-prov-remove-help = Its key is deleted and its models leave the model picker. Chats that used them stay readable.
integrations-prov-remove-confirm = Its key and settings are deleted. You can connect it again later.
integrations-prov-models-off = Turn the provider on to list its models.
# $when is a relative time such as "4 min ago"
integrations-prov-models-listed = Listed { $when }.
integrations-prov-models-from-test = From the last test: details appear after the next refresh.
integrations-prov-models-default = Turned-off models leave the model picker and cannot be used in chats.
integrations-prov-refresh-failed = Refresh failed: { $error }
integrations-prov-models-stale = Settings changed. The list updates when the refresh finishes.
integrations-prov-models-label = { $name } models
integrations-prov-blocked = Blocked by policy
integrations-prov-no-models = No models yet
integrations-prov-is-off = This provider is off
integrations-prov-no-models-help = Test the connection to list this provider's models.
integrations-prov-is-off-help = Turn it on to list its models.
integrations-prov-headers = Extra headers
integrations-prov-headers-help = Sent with every request. Values are stored as secrets.
integrations-prov-headers-list = Headers
integrations-prov-headers-save = Save headers

integrations-prov-connected-models =
    { $count ->
        [one] Connected. { $count } model available.
       *[other] Connected. { $count } models available.
    }

integrations-prov-health-models =
    { $count ->
        [one] { $count } model
       *[other] { $count } models
    }

# $off is the number of turned-off models
integrations-prov-health-models-off =
    { $count ->
        [one] { $count } model, { $off } off
       *[other] { $count } models, { $off } off
    }

integrations-prov-health-found =
    { $count ->
        [one] { $count } model found
       *[other] { $count } models found
    }

integrations-prov-turn-on =
    { $count ->
        [one] Turn on { $count } model
       *[other] Turn on { $count } models
    }

integrations-prov-turn-off =
    { $count ->
        [one] Turn off { $count } model
       *[other] Turn off { $count } models
    }

integrations-prov-models-total =
    { $count ->
        [one] { $count } model.
       *[other] { $count } models.
    }

integrations-prov-models-total-off =
    { $count ->
        [one] { $count } model, { $off } off.
       *[other] { $count } models, { $off } off.
    }

