/**
 * The audio device choices live in localStorage (settings/local-prefs.ts), which the Audio page
 * and the KVM screen's Audio devices dialog both write. A running stream has to re-pin the
 * microphone and the speaker when that happens; whoever wrote the choice says so here.
 */

const listeners = new Set<() => void>();

export function emitAudioDevicesChanged(): void {
    for (const listener of [...listeners]) listener();
}

export function onAudioDevicesChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
