// Browser origins allowed to call the API. HTTP CORS and the realtime socket
// share this list so the two can never drift apart.
export function allowedOrigins(): string[] {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  return Array.from(
    new Set([
      frontend,
      'http://localhost:3000',
      'https://reel2realbooking.in',
      'https://www.reel2realbooking.in',
    ]),
  ).filter(Boolean);
}
