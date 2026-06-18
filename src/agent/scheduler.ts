/**
 * Lets the agent schedule itself to run tasks later — once at a time, on an
 * interval, and/or only within a time-of-day window (e.g. after 17:30).
 * Jobs persist across restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

export interface Job {
    id: string;
    label: string;
    task: string;
    /** One-shot absolute time (ms epoch). */
    atTimestamp?: number;
    /** Recurring interval in minutes. */
    everyMinutes?: number;
    /** Only run at/after this time of day, "HH:MM". */
    afterTime?: string;
    /** Only run before this time of day, "HH:MM". */
    beforeTime?: string;
    enabled: boolean;
    createdAt: number;
    lastRun?: number;
    nextRun?: number;
}

function pad(n: number) {
    return String(n).padStart(2, "0");
}
function nowHHMM(d = new Date()): string {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse "HH:MM" into the next matching epoch (today, or tomorrow if passed). */
export function parseTimeToToday(hhmm: string): number | undefined {
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return undefined;
    const d = new Date();
    d.setHours(parseInt(m[1]!, 10), parseInt(m[2]!, 10), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
}

export class Scheduler {
    private jobs: Job[] = [];
    private seq = 0;
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private readonly path: string,
        private readonly runTask: (task: string, label: string) => void,
    ) {
        if (existsSync(path)) {
            try {
                const data = JSON.parse(readFileSync(path, "utf-8"));
                this.jobs = data.jobs ?? [];
                this.seq = data.seq ?? this.jobs.length;
            } catch {
                /* start empty */
            }
        }
    }

    private save() {
        try {
            writeFileSync(this.path, JSON.stringify({ jobs: this.jobs, seq: this.seq }, null, 2));
        } catch {
            /* best-effort */
        }
    }

    add(job: Omit<Job, "id" | "enabled" | "createdAt">): Job {
        const full: Job = { id: `job${++this.seq}`, enabled: true, createdAt: Date.now(), ...job };
        if (full.everyMinutes) full.nextRun = Date.now() + full.everyMinutes * 60_000;
        this.jobs.push(full);
        this.save();
        return full;
    }

    list(): Job[] {
        return [...this.jobs];
    }

    cancel(id: string): boolean {
        const before = this.jobs.length;
        this.jobs = this.jobs.filter((j) => j.id !== id);
        if (this.jobs.length !== before) this.save();
        return this.jobs.length !== before;
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick(), 30_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private tick(): void {
        const now = Date.now();
        const hhmm = nowHHMM();
        let dirty = false;
        const fire = (j: Job) => {
            j.lastRun = now;
            dirty = true;
            try {
                this.runTask(j.task, j.label);
            } catch {
                /* ignore */
            }
        };
        for (const j of this.jobs) {
            if (!j.enabled) continue;
            if (j.afterTime && hhmm < j.afterTime) continue;
            if (j.beforeTime && hhmm > j.beforeTime) continue;

            if (j.atTimestamp) {
                if (now >= j.atTimestamp) {
                    fire(j);
                    j.enabled = false; // one-shot
                }
            } else if (j.everyMinutes) {
                if (!j.nextRun || now >= j.nextRun) {
                    fire(j);
                    j.nextRun = now + j.everyMinutes * 60_000;
                }
            }
        }
        // Drop spent one-shots.
        const kept = this.jobs.filter((j) => j.enabled || j.everyMinutes);
        if (kept.length !== this.jobs.length) {
            this.jobs = kept;
            dirty = true;
        }
        if (dirty) this.save();
    }
}
