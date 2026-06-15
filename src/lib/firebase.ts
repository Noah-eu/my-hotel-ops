import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

type FirebaseEnvVarName =
    | 'VITE_FIREBASE_API_KEY'
    | 'VITE_FIREBASE_AUTH_DOMAIN'
    | 'VITE_FIREBASE_PROJECT_ID'
    | 'VITE_FIREBASE_STORAGE_BUCKET'
    | 'VITE_FIREBASE_MESSAGING_SENDER_ID'
    | 'VITE_FIREBASE_APP_ID'

const REQUIRED_FIREBASE_ENV_VARS: FirebaseEnvVarName[] = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID'
]

const DEV = import.meta.env.DEV

function devLog(message: string, payload?: unknown) {
    if (!DEV) return
    if (typeof payload === 'undefined') {
        console.info(`[Firebase] ${message}`)
        return
    }
    console.info(`[Firebase] ${message}`, payload)
}

const envMap: Record<FirebaseEnvVarName, string | undefined> = {
    VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
    VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    VITE_FIREBASE_STORAGE_BUCKET: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    VITE_FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID
}

export const missingFirebaseEnvVars = REQUIRED_FIREBASE_ENV_VARS.filter((name) => !envMap[name])

const firebaseConfig = {
    apiKey: envMap.VITE_FIREBASE_API_KEY,
    authDomain: envMap.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: envMap.VITE_FIREBASE_PROJECT_ID,
    storageBucket: envMap.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: envMap.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: envMap.VITE_FIREBASE_APP_ID
}

export const hasFirebaseConfig = missingFirebaseEnvVars.length === 0

export const firebaseEnvDiagnostics = {
    firebaseConfigured: hasFirebaseConfig,
    missingEnvVars: missingFirebaseEnvVars
}

devLog('Env validation result', firebaseEnvDiagnostics)

export const firebaseApp = hasFirebaseConfig ? initializeApp(firebaseConfig) : null
export const firestoreDb = firebaseApp ? getFirestore(firebaseApp) : null
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null

export type AppMode = 'demo' | 'online'
export const appMode: AppMode = hasFirebaseConfig ? 'online' : 'demo'

export async function ensureAnonymousAuth(): Promise<User | null> {
    if (!firebaseAuth) return null
    if (firebaseAuth.currentUser) return firebaseAuth.currentUser
    try {
        const cred = await signInAnonymously(firebaseAuth)
        devLog('Anonymous auth success', { uid: cred.user?.uid || null })
        return cred.user
    } catch (error: any) {
        devLog('Anonymous auth failed', {
            code: error?.code || null,
            message: error?.message || 'Unknown auth error'
        })
        throw error
    }
}

export function onFirebaseAuthState(callback: (user: User | null) => void): (() => void) | null {
    if (!firebaseAuth) return null
    return onAuthStateChanged(firebaseAuth, callback)
}
