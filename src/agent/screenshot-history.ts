/**
 * Ring buffer of recent screenshots so the agent can recover an earlier view
 * (via `view_screenshot`) even after it's been pruned from the active context.
 */

export interface StoredShot {
    id: string;
    base64: string;
    mimeType: string;
    width: number;
    height: number;
    at: number;
}

export class ScreenshotHistory {
    private items = new Map<string, StoredShot>();
    private order: string[] = [];
    private seq = 0;

    constructor(private readonly max = 40) {}

    add(shot: { base64: string; mimeType: string; width: number; height: number }): string {
        const id = `s${++this.seq}`;
        this.items.set(id, { id, ...shot, at: Date.now() });
        this.order.push(id);
        while (this.order.length > this.max) {
            const old = this.order.shift()!;
            this.items.delete(old);
        }
        return id;
    }

    get(id: string): StoredShot | undefined {
        return this.items.get(id);
    }

    list(): { id: string; width: number; height: number; at: number }[] {
        return this.order.map((id) => {
            const s = this.items.get(id)!;
            return { id, width: s.width, height: s.height, at: s.at };
        });
    }
}
