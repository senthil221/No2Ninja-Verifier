import { redirect } from "next/navigation";
import { endSession } from "@/lib/auth";

async function signOut() {
  "use server";
  await endSession();
  redirect("/login");
}

export default function SignOut({ email }: { email: string }) {
  return (
    <form action={signOut} className="signout">
      <span className="signout-email" title={email}>
        {email}
      </span>
      <button type="submit" className="signout-btn">
        Sign out
      </button>
    </form>
  );
}
