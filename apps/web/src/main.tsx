import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./app/router";
import { registerServiceWorkerForPage } from "./host/service-worker";
import { initTheme } from "./theme";
import "./styles.css";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: true },
        mutations: { retry: 0 },
    },
});

initTheme();
registerServiceWorkerForPage();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={createAppRouter()} />
        </QueryClientProvider>
    </StrictMode>,
);
