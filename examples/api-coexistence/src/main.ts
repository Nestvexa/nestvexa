import { createCoexistenceApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3885);
// The TCP microservice listens beside HTTP on the next port.
const microservicePort = Number(process.env['MICROSERVICE_PORT'] ?? port + 1);
// GATEWAY_PORT gives the Nest gateway its own server and enables the Nestvexa
// realtime WebSocket transport; by default the gateway shares the HTTP port.
const gatewayPort = process.env['GATEWAY_PORT'];
await createCoexistenceApp({
  port,
  microservicePort,
  gateway: gatewayPort ? Number(gatewayPort) : 'shared',
});
console.log(
  `API coexistence example: http://127.0.0.1:${port} (TCP microservice on ${microservicePort})`,
);
