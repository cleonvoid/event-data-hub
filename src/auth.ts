import type { User } from "firebase/auth";

/**
 * Browser-side Firebase Google sign-in.
 *
 * The Firebase SDK is loaded with a dynamic import so the app still runs (and
 * still builds) when no Firebase project is configured — in that case the
 * server is in AUTH_MODE=dev and no token is needed at all.
 *
 * Two credentials come out of a successful sign-in and they do different jobs:
 *   - the Firebase ID token  proves identity to OUR server
 *   - the Google access token authorises OUR server to call Drive/Sheets AS the
 *     user. It is held in memory only, never persisted.
 */

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

/** Scopes needed to list Drive files and read Sheets. Read-only by design. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

let googleAccessToken: string | null = null;
let authInstance: import("firebase/auth").Auth | null = null;

async function getAuthInstance() {
  if (authInstance) return authInstance;
  const [{ initializeApp, getApps }, { getAuth }] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);
  const app = getApps()[0] ?? initializeApp(firebaseConfig as Record<string, string>);
  authInstance = getAuth(app);
  return authInstance;
}

export async function signInWithGoogle(): Promise<User> {
  const { GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
  const auth = await getAuthInstance();

  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_SCOPES) provider.addScope(scope);

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  googleAccessToken = credential?.accessToken ?? null;
  return result.user;
}

export async function signOut(): Promise<void> {
  const auth = await getAuthInstance();
  const { signOut: fbSignOut } = await import("firebase/auth");
  googleAccessToken = null;
  await fbSignOut(auth);
}

export async function onAuthChange(cb: (user: User | null) => void): Promise<() => void> {
  if (!isFirebaseConfigured) {
    cb(null);
    return () => {};
  }
  const auth = await getAuthInstance();
  const { onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(auth, cb);
}

/** Firebase refreshes this automatically once it is within 5 minutes of expiry. */
export async function getIdToken(): Promise<string | null> {
  if (!isFirebaseConfigured) return null;
  const auth = await getAuthInstance();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}

export function getGoogleAccessToken(): string | null {
  return googleAccessToken;
}

/**
 * The Google access token from signInWithPopup expires in ~1 hour and, unlike
 * the ID token, the SDK does not refresh it. Re-running the popup is the
 * supported way to get a fresh one.
 */
export async function refreshGoogleAccessToken(): Promise<string | null> {
  await signInWithGoogle();
  return googleAccessToken;
}
