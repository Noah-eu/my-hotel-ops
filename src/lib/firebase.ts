import { initializeApp } from 'firebase/app'
import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut,
    type User
} from 'firebase/auth'
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

let pendingAnonymousAuthPromise: Promise<User | null> | null = null

function waitForAuthUser(timeoutMs = 15000, allowAnonymous = true): Promise<User> {
    return new Promise((resolve, reject) => {
        if (!firebaseAuth) {
            reject(new Error('Firebase auth not initialized'))
            return
        }

        const timeout = setTimeout(() => {
            unsubscribe()
            reject(new Error('Timed out waiting for anonymous auth user'))
        }, timeoutMs)

        const unsubscribe = onAuthStateChanged(
            firebaseAuth,
            (user) => {
                if (!user) return
                if (!allowAnonymous && user.isAnonymous) return
                clearTimeout(timeout)
                unsubscribe()
                resolve(user)
            },
            (error) => {
                clearTimeout(timeout)
                unsubscribe()
                reject(error)
            }
        )
    })
}

export async function ensureAuthenticatedUser(options?: { allowAnonymous?: boolean; timeoutMs?: number }): Promise<User | null> {
    const allowAnonymous = options?.allowAnonymous ?? false
    const timeoutMs = options?.timeoutMs ?? 15000

    if (!firebaseAuth) return null

    const current = firebaseAuth.currentUser
    if (current && (allowAnonymous || !current.isAnonymous)) {
        await current.getIdToken()
        return current
    }

    if (!allowAnonymous && current?.isAnonymous) {
        throw Object.assign(new Error('Anonymous user is not allowed for this operation'), { code: 'auth/requires-email-login' })
    }

    const user = await waitForAuthUser(timeoutMs, allowAnonymous)
    await user.getIdToken()
    return user
}

export async function ensureAnonymousAuth(): Promise<User | null> {
    if (!firebaseAuth) return null
    if (firebaseAuth.currentUser) {
        await firebaseAuth.currentUser.getIdToken()
        return firebaseAuth.currentUser
    }

    if (pendingAnonymousAuthPromise) {
        return pendingAnonymousAuthPromise
    }

    try {
        pendingAnonymousAuthPromise = (async () => {
            await signInAnonymously(firebaseAuth)
            const user = firebaseAuth.currentUser || await waitForAuthUser()
            await user.getIdToken()
            devLog('Anonymous auth success', { uid: user?.uid || null })
            return user
        })()

        return await pendingAnonymousAuthPromise
    } catch (error: any) {
        devLog('Anonymous auth failed', {
            code: error?.code || null,
            message: error?.message || 'Unknown auth error'
        })
        throw error
    } finally {
        pendingAnonymousAuthPromise = null
    }
}

export async function signInWithEmailPassword(email: string, password: string): Promise<User | null> {
    if (!firebaseAuth) return null
    const credential = await signInWithEmailAndPassword(firebaseAuth, email, password)
    await credential.user.getIdToken()
    devLog('Email/password auth success', { uid: credential.user.uid })
    return credential.user
}

export async function signOutFirebaseUser(): Promise<void> {
    if (!firebaseAuth) return
    await signOut(firebaseAuth)
    devLog('Auth sign-out completed')
}

export function onFirebaseAuthState(callback: (user: User | null) => void): (() => void) | null {
    if (!firebaseAuth) return null
    return onAuthStateChanged(firebaseAuth, callback)
}
