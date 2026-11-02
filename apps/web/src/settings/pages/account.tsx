import { OAUTH_SIGN_OUT_PATH } from "../../host/paths";
import { useProxySession } from "../../api/queries";
import { Group, Row } from "../../ui/controls";

export function AccountPage() {
    const session = useProxySession();

    if (!session.data) {
        return (
            <Group title="Account">
                <Row label="Not signed in through a proxy" hint="This host is not behind a sign-in proxy, so there is nothing to sign out of." />
            </Group>
        );
    }

    return (
        <Group title="Account" footer="You will be asked to sign in again to use this app.">
            <a className="row" href={OAUTH_SIGN_OUT_PATH}>
                <span className="row-text">
                    <span className="row-label" style={{ color: "var(--danger)" }}>
                        Sign out
                    </span>
                </span>
            </a>
        </Group>
    );
}
