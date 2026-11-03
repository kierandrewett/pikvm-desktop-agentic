/**
 * Test doubles and a small client for the PiKVM MCP server. Exposed as `@pikvm/mcp/testing` and
 * kept out of the package root so none of it reaches an app bundle.
 */
export {
    createTestClient,
    httpTransport,
    inProcessTransport,
    type CallResult,
    type TestClient,
    type Transport,
} from "./client";
export { createFakeApprover, createFakeDesk, type DeskCallRecord, type FakeApprover, type FakeDesk } from "./fakes";
