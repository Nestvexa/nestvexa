/** Process configuration shared by the bootstrap and the controllers. */
export const port = Number(process.env['PORT'] ?? 3119);
export const origin = `http://127.0.0.1:${port}`;
export const allowedOrigins: readonly string[] = [
  origin,
  `http://localhost:${port}`,
];
