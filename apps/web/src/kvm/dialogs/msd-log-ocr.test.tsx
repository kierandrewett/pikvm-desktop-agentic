// Failure modes 23-31 in FAILURE_MODES.md.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "../../test/harness";
import type { OcrPicker, PicturePixelRect } from "../ocr-picker";
import { LogDialog } from "./log-dialog";
import { MsdDialog } from "./msd-dialog";
import { OcrDialog } from "./ocr-dialog";
import { LOG_MAX_LINES } from "./model/log";
import { mountDialog, openRig, pi, stubFetch, textResponse, type Rig } from "./test-rig";

const picker = vi.hoisted(() => ({
    pending: [] as Array<(rect: PicturePixelRect | null) => void>,
    cancels: 0,
}));
vi.mock("../ocr-picker", () => ({
    useOcrPicker: (): OcrPicker => ({
        pick: () => new Promise((resolve) => picker.pending.push(resolve)),
        cancel: () => {
            picker.cancels++;
        },
    }),
}));

beforeEach(() => {
    installMatchMedia({ compact: false });
    picker.pending = [];
    picker.cancels = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const posted = (rig: Rig) => rig.http.requests.map((r) => r.path);

const drive = (over: Record<string, unknown> = {}) => ({
    image: { name: "a.iso", size: 1024 ** 3, in_storage: true, removable: true },
    cdrom: true,
    rw: false,
    connected: false,
    ...over,
});

const msdFrame = (over: Record<string, unknown> = {}, driveOver: Record<string, unknown> = {}) => ({
    enabled: true,
    online: true,
    busy: false,
    drive: drive(driveOver),
    storage: {
        parts: { "": { size: 8 * 1024 ** 3, free: 7 * 1024 ** 3 } },
        images: { "a.iso": { size: 1024 ** 3, mod_ts: 1 }, "b.iso": { size: 2048, mod_ts: 2 } },
        uploading: null,
        downloading: null,
    },
    ...over,
});

class FakeXhr {
    static instances: FakeXhr[] = [];
    method = "";
    url = "";
    body: unknown = undefined;
    status = 0;
    aborted = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    constructor() {
        FakeXhr.instances.push(this);
    }
    open(method: string, url: string): void {
        this.method = method;
        this.url = url;
    }
    send(body: unknown): void {
        this.body = body;
    }
    abort(): void {
        this.aborted = true;
        this.onabort?.();
    }
    finish(status: number): void {
        this.status = status;
        this.onload?.();
    }
}

describe("mass storage (23-26)", () => {
    async function mountMsd(frame: unknown = msdFrame()) {
        FakeXhr.instances = [];
        vi.stubGlobal("XMLHttpRequest", FakeXhr);
        const rig = await openRig();
        if (frame !== null) pi(rig, "msd", frame);
        const view = await mountDialog(MsdDialog, rig);
        return { rig, view };
    }

    it("23: says it is checking, not that there is no drive, before the first event", async () => {
        await mountMsd(null);
        expect(screen.getByText("Checking the drive\u2026")).toBeInTheDocument();
        expect(screen.queryByLabelText("Image")).toBeNull();
    });

    it("23: a PiKVM without mass storage gets the sentence, not a greyed form", async () => {
        const { rig } = await mountMsd(null);
        pi(rig, "msd", { enabled: false });
        expect(screen.getByText("This PiKVM has no mass storage.")).toBeInTheDocument();
        expect(screen.queryByLabelText("Image")).toBeNull();
        expect(screen.queryByRole("button", { name: "Reset drive" })).toBeNull();
    });

    it("24: lists images newest first and chooses one through kvmd", async () => {
        const { rig } = await mountMsd(msdFrame({}, { image: null }));
        const select = screen.getByLabelText("Image") as HTMLSelectElement;
        expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "b.iso", "a.iso"]);
        fireEvent.change(select, { target: { value: "b.iso" } });
        expect(posted(rig)).toEqual(["/api/msd/set_params?image=b.iso"]);
        await waitFor(() => expect(select).toHaveValue(""));
        pi(rig, "msd", msdFrame({}, { image: { name: "b.iso", size: 2048, in_storage: true, removable: true } }));
        expect(select).toHaveValue("b.iso");
    });

    it("24: mode and writable post their params; Writable only applies to a flash drive", async () => {
        const { rig } = await mountMsd();
        expect(screen.getByLabelText("Writable")).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "0" } });
        expect(posted(rig)).toEqual(["/api/msd/set_params?cdrom=0"]);
        pi(rig, "msd", msdFrame({}, { cdrom: false }));
        fireEvent.click(screen.getByLabelText("Writable"));
        expect(posted(rig)).toEqual(["/api/msd/set_params?cdrom=0", "/api/msd/set_params?rw=1"]);
    });

    it("24: Mount asks kvmd once however fast it is tapped, and says what it is doing in the present tense", async () => {
        const { rig } = await mountMsd();
        const gate = Promise.withResolvers<{ ok: boolean; status: number }>();
        rig.http.respond = () => gate.promise;
        const mount = screen.getByRole("button", { name: "Mount on the target" });
        fireEvent.click(mount);
        fireEvent.click(mount);
        expect(posted(rig)).toEqual(["/api/msd/set_connected?connected=1"]);
        gate.resolve({ ok: true, status: 200 });
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Mounting on the target\u2026"));
    });

    it("24: while mounted nothing can change; Unmount is offered instead of Mount", async () => {
        const { rig } = await mountMsd(msdFrame({}, { connected: true }));
        expect(screen.getByText(/Mounted on the target: a.iso as a CD\/DVD, read-only\./)).toBeInTheDocument();
        expect(screen.getByLabelText("Image")).toBeDisabled();
        expect(screen.getByLabelText("Mode")).toBeDisabled();
        expect(screen.getByLabelText("Upload")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete image" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Mount on the target" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Unmount" }));
        expect(posted(rig)).toEqual(["/api/msd/set_connected?connected=0"]);
    });

    it("24: a busy drive says so and disables everything", async () => {
        await mountMsd(msdFrame({ busy: true }));
        expect(screen.getByText(/The drive is busy/)).toBeInTheDocument();
        expect(screen.getByLabelText("Image")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reset drive" })).toBeDisabled();
    });

    it("26: Delete image and Reset drive ask first", async () => {
        const { rig } = await mountMsd();
        fireEvent.click(screen.getByRole("button", { name: "Delete image" }));
        const ask = screen.getByRole("alertdialog", { name: "Delete \u201ca.iso\u201d?" });
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(screen.getByRole("button", { name: "Delete image" }));
        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete image" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/msd/remove?image=a.iso"]));
        fireEvent.click(screen.getByRole("button", { name: "Reset drive" }));
        fireEvent.click(within(screen.getByRole("alertdialog", { name: "Reset the mass storage drive?" })).getByRole("button", { name: "Reset drive" }));
        await waitFor(() => expect(posted(rig)).toContain("/api/msd/reset"));
    });

    it("25: a file upload reports progress, posts the file name, and closing the dialog does not abort it", async () => {
        const { rig, view } = await mountMsd();
        const file = new File(["data"], "my disk.iso");
        fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [file] } });
        fireEvent.click(screen.getByRole("button", { name: "Start upload" }));
        const xhr = FakeXhr.instances[0]!;
        expect(xhr.method).toBe("POST");
        expect(xhr.url).toBe("/api/msd/write?image=my%20disk.iso&remove_incomplete=1");
        expect(xhr.body).toBe(file);
        act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 512 * 1024, total: 1024 * 1024 }));
        const bar = screen.getByRole("progressbar", { name: "Upload progress" });
        expect(bar).toHaveAttribute("value", "50");
        expect(screen.getByText(/50%\s+·\s+512 KB of 1\.0 MB/)).toBeInTheDocument();
        // While writing: Mount and the rest are off.
        expect(screen.getByRole("button", { name: "Mount on the target" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reset drive" })).toBeDisabled();
        view.unmount();
        expect(xhr.aborted).toBe(false);
        act(() => xhr.finish(200));
        expect(rig.session.notices.store.getState().text).toBe("Uploaded my disk.iso");
    });

    it("25: Abort is a calm confirmation, not an error", async () => {
        const { rig } = await mountMsd();
        fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [new File(["x"], "x.iso")] } });
        fireEvent.click(screen.getByRole("button", { name: "Start upload" }));
        fireEvent.click(screen.getByRole("button", { name: "Abort" }));
        expect(FakeXhr.instances[0]?.aborted).toBe(true);
        expect(rig.session.notices.store.getState()).toMatchObject({ text: "Upload aborted", error: false });
        expect(screen.queryByTestId("msd-progress")).toBeNull();
    });

    it("25: a failed upload says its status, and a network failure says so", async () => {
        const { rig } = await mountMsd();
        fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [new File(["x"], "x.iso")] } });
        fireEvent.click(screen.getByRole("button", { name: "Start upload" }));
        act(() => FakeXhr.instances[0]?.finish(507));
        expect(rig.session.notices.store.getState()).toMatchObject({ text: "Upload failed (507)", error: true });
        fireEvent.change(screen.getByLabelText("Upload"), { target: { files: [new File(["x"], "y.iso")] } });
        fireEvent.click(screen.getByRole("button", { name: "Start upload" }));
        act(() => FakeXhr.instances[1]?.onerror?.());
        expect(rig.session.notices.store.getState().text).toBe("Upload failed: network error");
    });

    it("25: an image URL is fetched by the Pi: indeterminate until it reports numbers, then a real bar", async () => {
        const { rig } = await mountMsd();
        fireEvent.change(screen.getByLabelText("or image URL"), { target: { value: "https://x.example/os.iso" } });
        fireEvent.click(screen.getByRole("button", { name: "Start upload" }));
        const xhr = FakeXhr.instances[0]!;
        expect(xhr.url).toBe("/api/msd/write_remote?url=https%3A%2F%2Fx.example%2Fos.iso&remove_incomplete=1");
        expect(xhr.body).toBeNull();
        const bar = screen.getByRole("progressbar", { name: "Upload progress" });
        expect(bar).not.toHaveAttribute("value");
        expect(screen.getByText("the Pi is downloading it\u2026")).toBeInTheDocument();
        pi(rig, "msd", msdFrame({ storage: { downloading: { name: "os.iso", written: 25, size: 100 } } }));
        await waitFor(() => expect(bar).toHaveAttribute("value", "25"));
        // Numbers vanish: back to "working, length unknown" rather than a frozen 25%.
        pi(rig, "msd", msdFrame({ storage: { downloading: { name: "os.iso" } } }));
        await waitFor(() => expect(bar).not.toHaveAttribute("value"));
    });

    it("shows the free space", async () => {
        await mountMsd();
        expect(screen.getByText("7.0 GB free")).toBeInTheDocument();
    });
});

describe("log (27-29)", () => {
    it("27: reads a snapshot, newest last, and copies only real text", async () => {
        const seen = stubFetch({ "/api/log": () => textResponse("line one\nline two\n") });
        const rig = await openRig();
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
        await mountDialog(LogDialog, rig);
        expect(screen.getByTestId("log-body")).toHaveTextContent("Loading\u2026");
        // 28: while it loads, Copy would copy the word "Loading".
        expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
        await waitFor(() => expect(screen.getByTestId("log-body")).toHaveTextContent("line one"));
        expect(seen[0]?.url).toBe("/api/log?seek=3600&follow=0");
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("line one\nline two\n"));
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Log copied"));
    });

    it("27: changing the window or refreshing reads again, and the old read is aborted", async () => {
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.signal) signals.push(init.signal);
                return new Promise<Response>(() => {});
            }),
        );
        await mountDialog(LogDialog);
        await waitFor(() => expect(signals).toHaveLength(1));
        fireEvent.change(screen.getByLabelText("Show"), { target: { value: "600" } });
        await waitFor(() => expect(signals).toHaveLength(2));
        expect(signals[0]?.aborted).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(signals).toHaveLength(3));
        expect(signals[1]?.aborted).toBe(true);
    });

    it("27: closing aborts the read in flight", async () => {
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.signal) signals.push(init.signal);
                return new Promise<Response>(() => {});
            }),
        );
        const view = await mountDialog(LogDialog);
        await waitFor(() => expect(signals).toHaveLength(1));
        view.unmount();
        expect(signals[0]?.aborted).toBe(true);
    });

    it("28: an empty window and an error are messages, not copyable", async () => {
        stubFetch({ "/api/log": () => textResponse("") });
        await mountDialog(LogDialog);
        await waitFor(() => expect(screen.getByTestId("log-body")).toHaveTextContent("(nothing in this window)"));
        expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
        stubFetch({ "/api/log": () => textResponse("no", 503) });
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(screen.getByTestId("log-body")).toHaveTextContent("Could not read the log: HTTP 503"));
        expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    });

    it("29: only the newest lines render, and the dropped count is said", async () => {
        const lines = Array.from({ length: LOG_MAX_LINES + 40 }, (_, i) => `entry ${i}`).join("\n");
        stubFetch({ "/api/log": () => textResponse(lines) });
        await mountDialog(LogDialog);
        await waitFor(() => expect(screen.getByTestId("log-body")).toHaveTextContent("40 earlier lines not shown"));
        expect(screen.getByTestId("log-body").textContent).toContain(`entry ${LOG_MAX_LINES + 39}`);
        expect(screen.getByTestId("log-body").textContent).not.toContain("entry 5\n");
    });
});

describe("text from the screen (30, 31)", () => {
    const ocr = { enabled: true, langs: { default: ["eng"], available: ["eng", "deu"] } };

    async function mountOcr(ocrState: unknown = ocr) {
        const rig = await openRig();
        if (ocrState !== null) pi(rig, "ocr", ocrState);
        const view = await mountDialog(OcrDialog, rig);
        return { rig, view };
    }

    it("30: draws nothing while aiming, reads the region the picker returns, and shows the text", async () => {
        const seen = stubFetch({ "/api/streamer/snapshot": () => textResponse("Hello world\n\n") });
        const { rig } = await mountOcr();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(picker.pending).toHaveLength(1);
        await act(async () => picker.pending[0]?.({ left: 10, top: 20, right: 300, bottom: 80 }));
        await waitFor(() => expect(screen.getByLabelText("Text read from the screen")).toHaveValue("Hello world"));
        expect(seen[0]?.url).toBe(
            "/api/streamer/snapshot?allow_offline=1&ocr=1&ocr_left=10&ocr_top=20&ocr_right=300&ocr_bottom=80&ocr_langs=eng",
        );
        const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("Hello world"));
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Text copied"));
    });

    it("30: a cancelled pick closes without a word", async () => {
        const { rig, view } = await mountOcr();
        await act(async () => picker.pending[0]?.(null));
        expect(view.closed.count).toBe(1);
        expect(rig.session.notices.store.getState().show).toBe(false);
    });

    it("30: closing while the picker is up cancels it, and a stale pick does nothing", async () => {
        const { view } = await mountOcr();
        view.unmount();
        expect(picker.cancels).toBe(1);
        await act(async () => picker.pending[0]?.({ left: 0, top: 0, right: 5, bottom: 5 }));
        expect(view.closed.count).toBe(0);
    });

    it("30: while reading it says so and Cancel gives up (aborting the read)", async () => {
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.signal) signals.push(init.signal);
                return new Promise<Response>(() => {});
            }),
        );
        const { view } = await mountOcr();
        await act(async () => picker.pending[0]?.({ left: 0, top: 0, right: 50, bottom: 50 }));
        expect(await screen.findByText(/Reading the screen/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(view.closed.count).toBe(1);
        view.unmount();
        expect(signals[0]?.aborted).toBe(true);
    });

    it("31: an empty result shows the sentence and Copy stays off", async () => {
        stubFetch({ "/api/streamer/snapshot": () => textResponse("  \n") });
        await mountOcr();
        await act(async () => picker.pending[0]?.({ left: 0, top: 0, right: 5, bottom: 5 }));
        await waitFor(() => expect(screen.getByLabelText("Text read from the screen")).toHaveValue("(no text found in that region)"));
        expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    });

    it("31: a failed read says why, and 'Read another region' aims again", async () => {
        stubFetch({ "/api/streamer/snapshot": () => textResponse("x", 500) });
        await mountOcr();
        await act(async () => picker.pending[0]?.({ left: 0, top: 0, right: 5, bottom: 5 }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the screen: HTTP 500");
        fireEvent.click(screen.getByRole("button", { name: "Read another region" }));
        await waitFor(() => expect(picker.pending).toHaveLength(2));
    });

    it("30: with OCR unavailable it says so instead of arming a picker", async () => {
        await mountOcr(null);
        expect(picker.pending).toHaveLength(0);
        expect(screen.getByRole("alert")).toHaveTextContent("This PiKVM has no text reading available.");
    });
});
