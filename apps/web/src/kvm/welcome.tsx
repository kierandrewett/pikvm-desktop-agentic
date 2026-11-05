/**
 * The first-run screen, drawn in the stage in place of the picture when there is no PiKVM to connect to. It says what
 * the app does and what it needs, then asks for the PiKVM: the same form Settings > Connection uses, so the checks and
 * the messages are the same. A quiet second route connects to a server instead, with the form Settings uses for that.
 * Either one ends in a reload, so the app starts again on what was just saved.
 */

import { Button, SettingsCard, SettingsScope } from "@pikvm/chat-web/settings";
import type { ServerEntry } from "@pikvm/contracts/api";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useKvmActive } from "./active";
import { ConnectForm } from "../settings/pages/connect-form";
import { PikvmForm } from "../settings/pages/target-form";

export function Welcome({ saved }: { readonly saved: ServerEntry | undefined }) {
    const headingId = useId();
    const [route, setRoute] = useState<"pikvm" | "server">("pikvm");
    const server = route === "server";
    const panel = useRef<HTMLDivElement>(null);
    const active = useKvmActive();
    // A save in flight belongs to the form on screen: switching forms would drop its answer, and with it the reload.
    const saving = useIsMutating() > 0;

    // The cursor goes to the first field whenever the screen is shown or the form changes. A tab that is not in front is
    // inert and cannot take focus, so this waits until it is.
    useEffect(() => {
        if (active) panel.current?.querySelector("input")?.focus();
    }, [active, route]);

    // The forms are the settings kit's, and the kit's tokens and utilities exist only inside its scope.
    return (
        <SettingsScope active={active}>
            <section className="kvm-welcome" aria-labelledby={headingId}>
                <div className="kvm-welcome-panel" ref={panel}>
                    <header className="kvm-welcome-head">
                        <h1 id={headingId}>Welcome to PiKVM</h1>
                        <p>Control a PiKVM from this computer. See its screen and use its keyboard and mouse.</p>
                        <p>
                            {server
                                ? "A server keeps your PiKVMs. You need its address and an access token."
                                : "You need the PiKVM's address and the account to sign in with."}
                        </p>
                    </header>
                    <SettingsCard>
                        {server ? (
                            <ConnectForm key="server" saved={saved} />
                        ) : (
                            <PikvmForm key="pikvm" submitLabel="Connect" />
                        )}
                    </SettingsCard>
                    <div className="kvm-welcome-other">
                        <Button variant="ghost" disabled={saving} onClick={() => setRoute(server ? "pikvm" : "server")}>
                            {server ? "Use a PiKVM instead" : "Use a server instead"}
                        </Button>
                    </div>
                </div>
            </section>
        </SettingsScope>
    );
}
