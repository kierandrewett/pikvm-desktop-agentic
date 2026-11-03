import { Button, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { OAUTH_SIGN_OUT_PATH } from "../../host/paths";
import { useProxySession } from "../../api/queries";

export function AccountPage() {
    const session = useProxySession();

    if (!session.data) {
        return (
            <SettingsPage title="Account">
                <SettingsSection>
                    <SettingsCard>
                        <SettingRow
                            label="Not signed in through a proxy"
                            description="This host has no sign-in proxy. There is nothing to sign out of."
                        />
                    </SettingsCard>
                </SettingsSection>
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Account" description="The sign-in for this host.">
            <SettingsSection>
                <SettingsCard>
                    <SettingRow
                        label="Sign out"
                        description="You must sign in again to use the app."
                        control={
                            <Button variant="danger" asChild>
                                <a href={OAUTH_SIGN_OUT_PATH}>Sign out</a>
                            </Button>
                        }
                    />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
