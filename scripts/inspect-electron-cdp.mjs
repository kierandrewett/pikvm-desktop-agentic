#!/usr/bin/env node

import WebSocket from "ws";

const port = Number(process.env.PIKVM_CDP_PORT || "9223");
const reloadMatch = process.env.PIKVM_CDP_RELOAD_MATCH || "";
const collectGarbage = process.env.PIKVM_CDP_COLLECT_GARBAGE === "1";
const clickMatch = process.env.PIKVM_CDP_CLICK_MATCH || "";
const clickLabel = process.env.PIKVM_CDP_CLICK_LABEL || "";
const fillMatch = process.env.PIKVM_CDP_FILL_MATCH || "";
const fillSelector = process.env.PIKVM_CDP_FILL_SELECTOR || "";
const fillValue = process.env.PIKVM_CDP_FILL_VALUE || "";
const bodyTextLimit = Math.min(
    20_000,
    Math.max(1_000, Number(process.env.PIKVM_CDP_BODY_TEXT_LIMIT || "1600")),
);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => {
    if (!res.ok) throw new Error(`CDP target discovery returned ${res.status}`);
    return res.json();
});

let nextId = 0;
async function inspectTarget(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    const pending = new Map();
    socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
    });
    const call = (method, params = {}) => {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
    };
    try {
        await call("Performance.enable");
        if (reloadMatch && target.url.includes(reloadMatch)) {
            await call("Page.reload", { ignoreCache: true });
            await new Promise((resolve) => setTimeout(resolve, 750));
        }
        if (
            fillSelector &&
            fillMatch &&
            target.url.includes(fillMatch)
        ) {
            const filled = await call("Runtime.evaluate", {
                expression: `(() => {
                    const element = document.querySelector(
                        ${JSON.stringify(fillSelector)}
                    );
                    if (
                        !(element instanceof HTMLInputElement) &&
                        !(element instanceof HTMLTextAreaElement)
                    ) return false;
                    const prototype = element instanceof HTMLTextAreaElement
                        ? HTMLTextAreaElement.prototype
                        : HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(
                        prototype,
                        "value",
                    )?.set;
                    setter?.call(element, ${JSON.stringify(fillValue)});
                    element.dispatchEvent(new Event("input", { bubbles: true }));
                    element.dispatchEvent(new Event("change", { bubbles: true }));
                    return true;
                })()`,
                returnByValue: true,
            });
            if (filled.result?.value !== true) {
                throw new Error(
                    `No editable field matching ${JSON.stringify(fillSelector)} in ${target.url}`,
                );
            }
        }
        if (
            clickLabel &&
            clickMatch &&
            target.url.includes(clickMatch)
        ) {
            const clicked = await call("Runtime.evaluate", {
                expression: `(() => {
                    const label = ${JSON.stringify(clickLabel)};
                    const element = [...document.querySelectorAll("button")]
                        .find((candidate) => {
                            const candidateLabel = (
                                candidate.getAttribute("aria-label") ||
                                candidate.textContent ||
                                candidate.getAttribute("title") ||
                                ""
                            ).trim().replace(/\\s+/g, " ");
                            return candidateLabel === label;
                        });
                    if (!element) return false;
                    element.click();
                    return true;
                })()`,
                returnByValue: true,
            });
            if (clicked.result?.value !== true) {
                throw new Error(
                    `No button with aria-label ${JSON.stringify(clickLabel)} in ${target.url}`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const evaluated = await call("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (collectGarbage) {
            await call("HeapProfiler.collectGarbage");
        }
        const metrics = await call("Performance.getMetrics");
        return { evaluated, metrics };
    } finally {
        socket.close();
    }
}

const expression = `(() => {
    const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            selector,
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
            display: style.display,
            visibility: style.visibility,
            overflow: style.overflow,
            gridColumn: style.gridColumn,
        };
    };
    const labels = (selector) =>
        [...document.querySelectorAll(selector)]
            .filter((element) => {
                const style = getComputedStyle(element);
                return style.display !== "none" && style.visibility !== "hidden";
            })
            .map((element) =>
                (element.labels?.[0]?.textContent ||
                    element.getAttribute("aria-label") ||
                    element.getAttribute("placeholder") ||
                    element.textContent ||
                    element.getAttribute("title") ||
                    "").trim().replace(/\\s+/g, " ").slice(0, 120)
            )
            .filter(Boolean)
            .slice(0, 80);
    const app = document.querySelector("#app");
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        viewport: {
            width: innerWidth,
            height: innerHeight,
            devicePixelRatio,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
        },
        classes: {
            html: document.documentElement.className,
            app: app?.className || null,
        },
        layout: {
            titlebar: rect("#titlebar"),
            app: rect("#app"),
            chat: rect(".chat"),
            chatFrame: rect("#chat-frame"),
            screen: rect("#screen-pane"),
            panelTabs: rect("#panel-tabs"),
            backendStatus: rect("#backend-status"),
            backendStatusText: rect("#backend-status .bs-text"),
            composer: rect("textarea, [contenteditable='true']"),
            primaryHeading: rect("h1, h2"),
        },
        activeTab:
            document.querySelector("#panel-tabs [data-tab].active")
                ?.getAttribute("data-tab") || null,
        selectedTabs: [...document.querySelectorAll("#panel-tabs [role='tab']")]
            .filter((element) => element.getAttribute("aria-selected") === "true")
            .map((element) => element.getAttribute("data-tab")),
        backendStatus: (() => {
            const element = document.querySelector("#backend-status");
            return element
                ? {
                    state: element.getAttribute("data-state"),
                    label: element.textContent?.trim() || "",
                    title: element.getAttribute("title") || "",
                }
                : null;
        })(),
        buttons: labels("button"),
        fields: labels("input, textarea, [contenteditable='true']"),
        headings: labels("h1, h2, h3"),
        dialogs: labels("[role='dialog'], dialog"),
        operational: {
            counts: {
                assistantMessages: document.querySelectorAll(
                    "[data-slot='aui_assistant-message-root']",
                ).length,
                userMessages: document.querySelectorAll(
                    "[data-slot='aui_user-message-root']",
                ).length,
                runActivities: document.querySelectorAll(
                    "[data-slot='aui_thread-run-activity']",
                ).length,
                branchPickers: document.querySelectorAll(
                    "[data-slot='aui-branch-picker-root']",
                ).length,
                toolGroups: document.querySelectorAll(
                    "[data-slot='tool-group-root']",
                ).length,
                genericToolCalls: document.querySelectorAll(
                    "[data-slot='tool-fallback-root']",
                ).length,
                computerActions:
                    document.querySelectorAll(".computer-action-step").length,
                statuses: document.querySelectorAll("[role='status']").length,
            },
            statusLabels: labels("[role='status']"),
            toolLabels: labels(
                "[data-slot='tool-group-trigger'], " +
                "[data-slot='tool-fallback-root'], " +
                ".computer-action-step",
            ),
        },
        topLevel: [...document.body.children].slice(0, 20).map((element) => {
            const box = element.getBoundingClientRect();
            return {
                tag: element.tagName.toLowerCase(),
                id: element.id || null,
                className:
                    typeof element.className === "string"
                        ? element.className.slice(0, 160)
                        : null,
                width: Math.round(box.width),
                height: Math.round(box.height),
            };
        }),
        computed: {
            body: (() => {
                const style = getComputedStyle(document.body);
                return {
                    backgroundColor: style.backgroundColor,
                    color: style.color,
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize,
                };
            })(),
            primaryButton: (() => {
                const element = document.querySelector("button");
                if (!element) return null;
                const style = getComputedStyle(element);
                return {
                    backgroundColor: style.backgroundColor,
                    color: style.color,
                    border: style.border,
                    borderRadius: style.borderRadius,
                    fontSize: style.fontSize,
                };
            })(),
        },
        loading: {
            navigation: navigation
                ? {
                    responseEnd: Math.round(navigation.responseEnd * 100) / 100,
                    domContentLoaded: Math.round(navigation.domContentLoadedEventEnd * 100) / 100,
                    load: Math.round(navigation.loadEventEnd * 100) / 100,
                    duration: Math.round(navigation.duration * 100) / 100,
                    transferSize: navigation.transferSize,
                    decodedBodySize: navigation.decodedBodySize,
                }
                : null,
            resources: {
                count: resources.length,
                transferSize: resources.reduce(
                    (total, entry) => total + (entry.transferSize || 0),
                    0,
                ),
                decodedBodySize: resources.reduce(
                    (total, entry) => total + (entry.decodedBodySize || 0),
                    0,
                ),
                javascript: resources
                    .filter((entry) => entry.name.endsWith(".js"))
                    .map((entry) => new URL(entry.name).pathname.split("/").pop()),
            },
        },
        bodyText: (document.body?.innerText || "")
            .trim()
            .replace(/\\n{3,}/g, "\\n\\n")
            .slice(0, ${bodyTextLimit}),
    };
})()`;

const pages = targets.filter((target) => target.type === "page" && target.url);
const reports = [];
for (const target of pages) {
    const { evaluated, metrics } = await inspectTarget(target);
    const metric = Object.fromEntries(
        (metrics.metrics || [])
            .filter(({ name }) =>
                [
                    "Documents",
                    "Frames",
                    "JSEventListeners",
                    "Nodes",
                    "LayoutCount",
                    "RecalcStyleCount",
                    "ScriptDuration",
                    "TaskDuration",
                    "JSHeapUsedSize",
                ].includes(name),
            )
            .map(({ name, value }) => [name, value]),
    );
    reports.push({
        target: {
            id: target.id,
            title: target.title,
            url: target.url,
        },
        document: evaluated.result?.value,
        performance: metric,
    });
}

process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
