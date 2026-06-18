function deriveAutoConfirmMode({ enabled, dryRun }) {
    if (enabled) return 'enabled'
    if (dryRun) return 'dry-run'
    return 'off'
}

function assertMode(enabled, dryRun, expected) {
    const actual = deriveAutoConfirmMode({ enabled, dryRun })
    if (actual !== expected) {
        throw new Error(`Mode mismatch for enabled=${enabled}, dryRun=${dryRun}: expected ${expected}, got ${actual}`)
    }
}

function run() {
    assertMode(false, true, 'dry-run')
    assertMode(false, false, 'off')
    assertMode(true, true, 'enabled')
    assertMode(true, false, 'enabled')

    console.info('[validate:auto-confirm-mode] PASS')
    console.info('- enabled=false, dryRun=true => dry-run')
    console.info('- enabled=false, dryRun=false => off')
    console.info('- enabled=true, dryRun=true => enabled')
    console.info('- enabled=true, dryRun=false => enabled')
}

run()
