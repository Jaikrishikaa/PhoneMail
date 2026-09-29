// Runs the configured temporary preview alongside a demo instance on port 3000.
require("dotenv").config({ quiet: true });
process.env.PORT = process.env.PORT || "3001";
if (process.env.DATABASE_URL_PREVIEW) process.env.DATABASE_URL = process.env.DATABASE_URL_PREVIEW;
// Docker service names only resolve inside Compose; use its host-mapped Postgres
// port when this launcher runs directly on the development machine.
if (process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.DATABASE_URL.replace("@postgres:", "@127.0.0.1:");
require("../server");
