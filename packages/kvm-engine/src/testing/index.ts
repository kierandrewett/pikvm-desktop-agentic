/**
 * Test doubles for the engine's ports. Exposed as `@pikvm/kvm-engine/testing` and deliberately
 * NOT re-exported from the package root, so none of it reaches an app bundle.
 */
export { FakeHttp, FakeSocket, FakeSocketHub, status, type SentCommand } from "./fake-socket";
export { FakeKeyTarget } from "./fake-key-target";
