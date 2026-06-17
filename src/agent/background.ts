/**
 * Background tasks: long-running actions (e.g. typing a big document) run async
 * while the agent does other things or "sleeps" and is woken on completion.
 */

export interface BgTask {
    id: string;
    label: string;
    status: "running" | "done" | "error";
    progress: string;
    result?: string;
    error?: string;
    startedAt: number;
}

export class BackgroundTasks {
    private tasks = new Map<string, BgTask>();
    private seq = 0;

    start(label: string, fn: (report: (p: string) => void) => Promise<string>): string {
        const id = `bg${++this.seq}`;
        const task: BgTask = { id, label, status: "running", progress: "", startedAt: Date.now() };
        this.tasks.set(id, task);
        fn((p) => {
            task.progress = p;
        })
            .then((r) => {
                task.status = "done";
                task.result = r;
            })
            .catch((e) => {
                task.status = "error";
                task.error = e instanceof Error ? e.message : String(e);
            });
        return id;
    }

    get(id: string): BgTask | undefined {
        return this.tasks.get(id);
    }

    list(): BgTask[] {
        return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
    }

    /** Resolve when the task finishes (the agent "sleeps" until then). */
    wait(id: string, signal?: AbortSignal, pollMs = 400): Promise<BgTask> {
        return new Promise((resolve, reject) => {
            const tick = () => {
                const t = this.tasks.get(id);
                if (!t) return reject(new Error(`No task ${id}`));
                if (t.status !== "running") return resolve(t);
                if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
                setTimeout(tick, pollMs);
            };
            tick();
        });
    }
}
