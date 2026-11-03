// Read by `yarn workspace @pikvm/chat-server db:generate`, which writes the next migration into ./migrations.
export default {
    dialect: "sqlite",
    schema: "./src/db/schema.ts",
    out: "./migrations",
};
