# E2E run: desktop feedback (2026-11-03)

## Desktop feedback: the chat composer and the navigation rail (2026-11-03)

Stack: the web host with the chat server and the real `omp` binary in it, in front of `tools/fake-kvmd`, with `tools/fake-model` as the provider (`apps/web/e2e/chat-stack.mjs`). Browser: headless Chrome through puppeteer-core, dark scheme; desktop at 1280x800, 1920x1080, 2560x1440 and 760x700 (the narrowest wide layout), plus an iPhone 13. Script: `apps/web/e2e/desktop-layout.e2e.mjs`.

Rail before: 64px wide, tabs 47x52, icon over a label; the page beside it 1216px at 1280.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| desktop 1280x800 | the rail has no visible text, and each item has an accessible name | tab-kvm: name "KVM", visible text ""; tab-chat: name "Chat", visible text ""; tab-settings: name "Settings", visible text "" | pass |
| desktop 1280x800 | the rail is narrower than before and the page gets the room | rail 45px wide (was 64px), tab 36x36 (was 47x52), page 1235px (was 1216px) | pass |
| desktop 1280x800 | each item shows its name as a tooltip on hover | kvm: "KVM" visible; chat: "Chat" visible; settings: "Settings" visible; hidden again once the pointer leaves: hidden | pass |
| desktop 1280x800 | the tooltip also shows on keyboard focus, and the focused item has a visible ring | focused tab-chat: tip "Chat" visible, ring color(srgb 0.356863 0.54902 1 / 0.85) 0px 0px 0px 2px | pass |
| desktop 1280x800 | the open item is marked by colour, fill weight and a background, and only one is | tab-kvm selected=true bg color(srgb 0.356863 0.54902 1 / 0.16) colour rgb(91, 140, 255); tab-chat selected=false bg rgba(0, 0, 0, 0) colour rgb(138, 138, 149); tab-settings selected=false bg rgba(0, 0, 0, 0) colour rgb(138, 138, 149) | pass |
| desktop 1280x800 | new chat: the composer is the conversation's column (same width, same centre), the heading above it | composer 768px wide at 438.5px..1206.5px; column 768px at 438.5px..1206.5px | pass |
| desktop 1920x1080 | new chat: the composer is the conversation's column (same width, same centre), the heading above it | composer 768px wide at 758.5px..1526.5px; column 768px at 758.5px..1526.5px | pass |
| desktop 2560x1440 | new chat: the composer is the conversation's column (same width, same centre), the heading above it | composer 768px wide at 1078.5px..1846.5px; column 768px at 1078.5px..1846.5px | pass |
| desktop 760x700 | new chat: the composer is the conversation's column (same width, same centre), the heading above it | composer 369px wide at 361px..730px; column 369px at 361px..730px | pass |
| desktop 1280x800 | conversation: the composer is the thread column (same width, same centre) | composer 768px wide at 438.5px..1206.5px; column 768px at 438.5px..1206.5px | pass |
| desktop 1280x800 | a long text keeps the composer bounded and scrolls inside it | 80 lines: composer 271.5px tall (empty 45.5px; bound 400px), text area 231px showing 2109px of text, overflow-y auto; still 768px wide | pass |
| desktop 1920x1080 | conversation: the composer is the thread column (same width, same centre) | composer 768px wide at 758.5px..1526.5px; column 768px at 758.5px..1526.5px | pass |
| desktop 1920x1080 | a long text keeps the composer bounded and scrolls inside it | 80 lines: composer 341.5px tall (empty 45.5px; bound 420px), text area 301px showing 2109px of text, overflow-y auto; still 768px wide | pass |
| desktop 2560x1440 | conversation: the composer is the thread column (same width, same centre) | composer 768px wide at 1078.5px..1846.5px; column 768px at 1078.5px..1846.5px | pass |
| desktop 2560x1440 | a long text keeps the composer bounded and scrolls inside it | 80 lines: composer 391.5px tall (empty 45.5px; bound 420px), text area 351px showing 2109px of text, overflow-y auto; still 768px wide | pass |
| desktop 760x700 | conversation: the composer is the thread column (same width, same centre) | composer 369px wide at 361px..730px; column 369px at 361px..730px | pass |
| desktop 760x700 | a long text keeps the composer bounded and scrolls inside it | 80 lines: composer 246.5px tall (empty 45.5px; bound 350px), text area 206px showing 4189px of text, overflow-y auto; still 369px wide | pass |
| desktop 1280x800 | no page error, and no failed request except the login-proxy probe | clean | pass |
| iPhone 13 | the bottom bar keeps its labels and has no rail | labels KVM, Chat, Settings; rails 0; tips 0; bar 57px | pass |
| iPhone 13 | new chat: the composer keeps its 12px gutters | left 12px, right 12px | pass |

20 of 20 passed.

- [rail-tooltip-hover](desktop-feedback/rail-tooltip-hover.png)
- [rail-tooltip-focus](desktop-feedback/rail-tooltip-focus.png)
- [1280x800-new-chat](desktop-feedback/1280x800-new-chat.png)
- [1280x800-conversation](desktop-feedback/1280x800-conversation.png)
- [1280x800-long-text](desktop-feedback/1280x800-long-text.png)
- [1920x1080-new-chat](desktop-feedback/1920x1080-new-chat.png)
- [1920x1080-conversation](desktop-feedback/1920x1080-conversation.png)
- [1920x1080-long-text](desktop-feedback/1920x1080-long-text.png)
- [2560x1440-new-chat](desktop-feedback/2560x1440-new-chat.png)
- [2560x1440-conversation](desktop-feedback/2560x1440-conversation.png)
- [2560x1440-long-text](desktop-feedback/2560x1440-long-text.png)
- [760x700-new-chat](desktop-feedback/760x700-new-chat.png)
- [760x700-conversation](desktop-feedback/760x700-conversation.png)
- [760x700-long-text](desktop-feedback/760x700-long-text.png)
- [1280x800-kvm](desktop-feedback/1280x800-kvm.png)
- [1280x800-chat-after](desktop-feedback/1280x800-chat-after.png)
- [phone-kvm](desktop-feedback/phone-kvm.png)
- [phone-new-chat](desktop-feedback/phone-new-chat.png)
- [before-1280x800-kvm](desktop-feedback/before-1280x800-kvm.png) (the 64px labelled rail, from 10a037e9)
