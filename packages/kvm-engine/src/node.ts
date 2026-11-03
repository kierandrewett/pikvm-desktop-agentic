// The Node-only entry: sockets that need `ws`. Kept off the package root so a browser bundle never imports it.
export { nodeSocket, type NodeSocketOptions } from "./target/node-socket";
