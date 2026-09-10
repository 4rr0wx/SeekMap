import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const { app, io, stopTimer } = await buildApp(config, database);

const shutdown = async () => {
  stopTimer();
  io.close();
  await app.close();
  database.sqlite.close();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exit(1);
}
