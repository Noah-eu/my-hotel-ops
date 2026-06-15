import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
}

export const hasFirebaseConfig = Object.values(firebaseConfig).every((value) => Boolean(value))

export const firebaseApp = hasFirebaseConfig ? initializeApp(firebaseConfig) : null
export const firestoreDb = firebaseApp ? getFirestore(firebaseApp) : null
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null

export type AppMode = 'demo' | 'online'
export const appMode: AppMode = hasFirebaseConfig ? 'online' : 'demo'

export async function ensureAnonymousAuth(): Promise<User | null> {
    if (!firebaseAuth) return null
    if (firebaseAuth.currentUser) return firebaseAuth.currentUser
    const cred = await signInAnonymously(firebaseAuth)
    return cred.user
}

export function onFirebaseAuthState(callback: (user: User | null) => void): (() => void) | null {
    if (!firebaseAuth) return null
    return onAuthStateChanged(firebaseAuth, callback)
}
