import { buildServer } from './server.js';
import { config } from './config/index.js';
import { closePools } from './database/pool.js';

async function main() {
  const server = await buildServer();

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      server.log.info({ signal }, 'Received shutdown signal');
      await server.close();
      await closePools();
      process.exit(0);
    });
  }

  try {
    await server.listen({
      port: config.server.port,
      host: config.server.host,
    });

    server.log.info(
      `Server listening on http://${config.server.host}:${config.server.port}`,
    );
    server.log.info(
      `Swagger UI available at http://${config.server.host}:${config.server.port}/docs`,
    );
  } catch (error) {
    server.log.error(error, 'Failed to start server');
    process.exit(1);
  }
}

main();
