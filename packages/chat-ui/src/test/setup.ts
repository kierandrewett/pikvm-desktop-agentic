import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installDomStubs } from "./dom-stubs";

installDomStubs();

afterEach(() => {
    cleanup();
});
