import { signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

export type Gate = "owner" | "refused";

// The page does not know the owner's email. It asks Firestore: only the owner may read meta/owner.
// Any other account gets permission-denied and is signed out at once.
export async function checkOwner(user: User): Promise<Gate> {
  if (user.providerData[0]?.providerId !== "google.com" || !user.emailVerified) {
    await signOut(auth);
    return "refused";
  }
  try {
    await getDoc(doc(db, "meta", "owner"));
    return "owner";
  } catch {
    await signOut(auth);
    return "refused";
  }
}
