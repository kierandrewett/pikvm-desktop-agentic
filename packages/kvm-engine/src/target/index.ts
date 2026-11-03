export { browserSocket, eventSocketUrl } from "./browser-socket.dom";
export {
    applyFrame,
    CAPS_PENDING_MS,
    capsPending,
    initialDeviceState,
    noteCapsToggle,
    type CapsState,
    type DeviceState,
} from "./device-state";
export { bindLinkLifecycle, type LinkLifecycleHooks } from "./lifecycle.dom";
export { networkCameBack, returnedFromBackground } from "./lifecycle";
export {
    createTargetLink,
    defaultLinkTiming,
    type LinkStatus,
    type LinkTiming,
    type TargetLink,
    type TargetLinkOptions,
    type TargetState,
} from "./link";
export { createOutboundQueue, QUEUE_MAX, QUEUE_STALE_MS, type OutboundQueue } from "./outbound-queue";
export type { KvmSocket, SocketFactory, SocketHandlers } from "./ports";
export {
    isRelease,
    type AtxState,
    type GpioState,
    type HidCommand,
    type HidStatus,
    type InfoState,
    type KvmdKeymaps,
    type MouseButton,
    type MouseStatus,
    type MsdState,
    type MsdStorage,
    type OcrStatus,
    type StreamerSettings,
} from "./wire";
