import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import {
	claimDuePinProxySwitches,
	finishPinProxySwitch,
	notePinProxySwitch,
} from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import {
	findModByIdOrFullName,
	moveProxyPinToThunderstore,
} from '../../infrastructure/gateways/mods.gateway.js'
import { logDeployAction } from '../deploy/deploy-auth.js'
import { syncModRegistry } from './mods-sync.service.js'
import {
	type PinProxySwitchDeps,
	runPinProxySwitches,
} from './pin-proxy-switch.service.js'
import { checkThunderstoreVersion } from './thunderstore-version-check.js'

// Runs the pin proxy's timer (pin-proxy-switch.service.ts). The due times are
// in the database, so a restart loses nothing: the first tick after boot
// takes whatever came due meanwhile. The tick is short because the service
// only does work for a switch whose own time has come.

export const PIN_PROXY_TICK_MS = 30 * 1000

const liveDeps: PinProxySwitchDeps = {
	claimDue: claimDuePinProxySwitches,
	findMod: findModByIdOrFullName,
	thunderstoreStatus: checkThunderstoreVersion,
	refreshVersions: async () => {
		await syncModRegistry()
	},
	moveToThunderstore: moveProxyPinToThunderstore,
	note: notePinProxySwitch,
	finish: finishPinProxySwitch,
	reloadConfig: async () => {
		await loadConfigFromDb()
	},
	logSwitch: (entry) =>
		logDeployAction({
			action: 'mod_pin',
			reason:
				'Thunderstore approved the version, so the pin moved from the proxy to Thunderstore',
			detail: {
				modId: entry.modId,
				old: { rankedVersion: entry.version, source: 'github-proxy' },
				new: { rankedVersion: entry.version, source: 'thunderstore' },
				hash: entry.hash,
				proxyHash: entry.proxyHash,
				hashChanged: entry.hashChanged,
			},
		}),
	now: () => new Date(),
}

let running = false

export async function pinProxyTick(): Promise<void> {
	if (running) return
	running = true
	try {
		await runPinProxySwitches(liveDeps)
	} catch (err) {
		console.error('[pin-proxy] Tick failed:', err)
	} finally {
		running = false
	}
}

export function startPinProxySwitchJob(): void {
	void pinProxyTick()
	setInterval(() => void pinProxyTick(), PIN_PROXY_TICK_MS).unref()
}
