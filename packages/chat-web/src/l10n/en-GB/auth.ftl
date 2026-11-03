# Sign-in, account creation and two-factor screens (components/auth).
# $instanceName is the server's display name (bootstrap instanceName, "Chat" by default).

## Page headings and subtitles

auth-heading-setup = Set up your server
auth-heading-signup = Create your account
auth-heading-two-factor = Two-factor check
auth-heading-backup-code = Use a backup code
auth-heading-signin = Welcome back

auth-subtitle-setup = This is the first account on { $instanceName }. It becomes the administrator, who manages people and server settings.
auth-subtitle-signup = Join { $instanceName } with your email address.
auth-subtitle-totp = Enter the 6-digit code from your authenticator app.
auth-subtitle-backup = Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once.
auth-subtitle-signin = Sign in to { $instanceName } to continue.

auth-load-error-title = Cannot load sign-in
auth-load-error-message = Could not load sign-in options.
auth-loading-label = Loading sign-in options
auth-loading-status = Loading sign-in options.

## Notices at the top of the card

auth-reason-expired = Your session has ended. Sign in again to continue.
auth-reason-signed-out = You have signed out.
auth-account-created = Account created. Sign in to continue.
auth-callback-cancelled = Sign-in was cancelled at the provider.
auth-callback-signup-closed = No account matches that sign-in, and new accounts are closed. Ask an administrator for an account.
auth-callback-not-linked = That provider account is not linked to an account here. Sign in another way, then link it in Settings.
# $reason is the provider's error code with underscores as spaces ("server error").
auth-callback-failed = Sign-in with that provider did not finish ({ $reason }). Try again.

## Server errors

auth-cooldown =
    { $seconds ->
        [one] Too many attempts. Try again in { $seconds } second.
       *[other] Too many attempts. Try again in { $seconds } seconds.
    }
auth-error-rate-limited = Too many attempts. Wait a moment and try again.
auth-error-invalid-credentials = That email and password do not match. Check both and try again.
auth-error-banned = This account is suspended. Ask an administrator for help.
auth-error-invalid-code = That code did not work. Check it and try again.
auth-error-locked = Too many wrong codes. Wait a few minutes, then sign in again.
auth-error-attempt-expired = This sign-in attempt has expired. Go back and sign in again.
auth-error-unreachable = Could not reach the server. Check your connection and try again.
auth-error-session-unconfirmed = Could not confirm your session. Check your connection, then reload this page before you try again.
auth-error-no-session = Signed in, but no session was created. Try again.
auth-error-signin-failed = Sign-in failed. Try again.
auth-error-passkey-failed = Passkey sign-in did not work. Try again.
auth-error-social-failed = Could not start sign-in with that provider.
auth-error-signup-failed = Could not create the account. Try again.
auth-error-code-failed = That code did not work. Try again.

## Sign in

auth-passkey-use = Use a passkey
auth-passkey-waiting = Waiting for your passkey
# $provider is a product name such as GitHub or Google.
auth-continue-with = Continue with { $provider }
auth-or = or
auth-signin-form-label = Sign in with email
auth-forgot-password = Forgot password?
auth-forgot-password-help = Ask an administrator of { $instanceName } to set a new password for you.
auth-sign-in = Sign in
auth-signing-in = Signing in
auth-no-methods-title = No sign-in methods are available.
auth-no-methods-description = Ask an administrator to enable a sign-in method in the server settings.
# <create> wraps the link to the sign-up form.
auth-signup-prompt = New to { $instanceName }? <create>Create an account</create>
auth-no-signup = Need an account? Ask your administrator for one.

## Fields

auth-name-label = Name
auth-email-label = Email
auth-password-label = Password
auth-name-required = Enter your name.
auth-email-required = Enter your email address.
auth-email-invalid = Enter an email address like name@example.com.
auth-password-required = Enter your password.
auth-email-taken = An account with this email already exists. Sign in instead.
auth-password-too-short =
    { $min ->
        [one] Use at least { $min } character.
       *[other] Use at least { $min } characters.
    }
auth-password-hint =
    { $min ->
        [one] At least { $min } character.
       *[other] At least { $min } characters.
    }
auth-caps-lock = Caps Lock is on.
auth-show-password = Show password
auth-hide-password = Hide password

## Create account

auth-submit-create-admin = Create admin account
auth-submit-create-account = Create account
auth-signup-form-label = Create an account
# <signin> wraps the link back to the sign-in form.
auth-signin-prompt = Already have an account? <signin>Sign in</signin>

## Two-factor

auth-totp-form-label = Authenticator code
auth-totp-label = 6-digit code
auth-backup-code-label = Backup code
auth-code-incomplete = Enter all 6 digits.
auth-backup-code-required = Enter one of your backup codes.
auth-trust-device =
    { $days ->
        [one] Trust this device for { $days } day
       *[other] Trust this device for { $days } days
    }
auth-verify = Verify
auth-use-backup = Use a backup code instead
auth-use-authenticator = Use your authenticator app instead
auth-back-to-signin = Back to sign in

# Tab titles. The tab names the task, not the greeting.

auth-tab-setup = Set up
auth-tab-signup = Create account
auth-tab-2fa = Two-factor check
auth-tab-signin = Sign in
