// Deliberately dependency-free. Middleware runs on the edge runtime, so
// anything it imports must not reach for Node built-ins or Prisma --
// importing this constant from lib/auth pulled both into the edge bundle
// and broke every route.
export const SESSION_COOKIE = "wv_session";
