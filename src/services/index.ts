import { appMode } from '../lib/firebase'
import { createFirebaseOpsStore } from './firebaseOpsStore'
import { createLocalOpsStore } from './localOpsStore'
import { OpsStore } from './opsStore'

export function createOpsStore(): OpsStore {
    if (appMode === 'online') {
        return createFirebaseOpsStore()
    }
    return createLocalOpsStore()
}
