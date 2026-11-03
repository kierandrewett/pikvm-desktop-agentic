# Error text (lib/errors.ts). describeError() maps a failure to one of these. Server messages stay as the server wrote them.

errors-offline-title = You are offline
errors-offline-message = Reconnect to the internet, then try again.
errors-unreachable-title = Cannot reach the server
errors-unreachable-message = Check your connection, then try again.
errors-session-title = Your session has ended
errors-session-message = Sign in again to continue.
errors-forbidden-title = No access
errors-forbidden-message = Your account cannot open this. An administrator can change that.
errors-not-found-title = Not found
errors-not-found-message = It may have been deleted, or the link is wrong.
errors-too-large-title = This request is too large
errors-no-space-title = Not enough space
errors-rate-title = Too many requests
errors-rate-message = Wait a moment, then try again.
errors-generic-title = Something went wrong
errors-server-message = The server could not complete the request. Try again in a moment.
errors-request-title = That did not work
errors-unknown-message = Try again. If it keeps happening, reload the page.
errors-try-again-sentence = Try again.

## Empty and error state primitives (components/ui/state.tsx).

state-retry = Try again
state-details = Details
state-copied = Copied
state-copy = Copy details
state-copy-failed = Could not copy. Select the details and copy them manually.
state-copy-done = Details copied.

## Router states (components/ui/route-states.tsx).

route-not-found-title = Page not found
route-not-found-description = The link may be broken, or the page may have moved.
route-new-chat = Start a new chat
route-go-home = Go to Chat
route-error-tab = Error
route-error-title = This page could not be shown
route-error-description = Something went wrong while showing it. Try again, or start a new chat.
route-load-tab = Could not load
route-load-title = Chat could not load
route-load-offline = Chat could not load. Check your connection, then try again.
route-reload = Reload page
