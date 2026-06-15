import { appMode } from '../lib/firebase'
import { createFirebaseOpsStore } from './firebaseOpsStore'
import { createLocalOpsStore } from './localOpsStore'
import { OpsStore } from './opsStore'

export { createFirebaseOpsStore } from './firebaseOpsStore'
export { createLocalOpsStore } from './localOpsStore'

export function createOpsStore(): OpsStore {
    if (appMode === 'online') {
        return createFirebaseOpsStore()
    }
    return createLocalOpsStore()
}
