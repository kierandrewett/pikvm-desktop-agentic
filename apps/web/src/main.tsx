import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./app/router";
import { markStandalone } from "./app/standalone";
import { registerServiceWorkerForPage } from "./host/service-worker";
import { watchPageForUpdates } from "./host/update";
import { initTheme } from "./theme";
import "./styles.css";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: true },
        mutations: { retry: 0 },
    },
});

markStandalone();
initTheme();
registerServiceWorkerForPage();
watchPageForUpdates();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={createAppRouter()} />
        </QueryClientProvider>
    </StrictMode>,
);
