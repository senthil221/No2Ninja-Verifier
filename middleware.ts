import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

// Middleware runs on the edge runtime, where Prisma is unavailable, so this
// only checks that a session cookie is present. That is enough to redirect
// anonymous visitors; the cookie's validity is verified server-side by
// requireUser() on every page and API route, which is what actually guards
// the data.
const PUBLIC_PATHS = ["/login", "/setup"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.url);
  // Send the visitor back where they were headed once signed in.
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
