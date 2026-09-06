process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.CORS_ORIGINS ??= "http://localhost:3000,http://localhost:1420";
process.env.PORT ??= "3001";
process.env.NODE_ENV ??= "test";
