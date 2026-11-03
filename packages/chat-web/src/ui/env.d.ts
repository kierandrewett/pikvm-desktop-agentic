/** The only bundler API the package touches: Vite's HMR dispose hook in lib/instant.ts. */
interface ImportMeta {
    readonly hot?: { dispose(callback: () => void): void };
}

declare module "*.css";
