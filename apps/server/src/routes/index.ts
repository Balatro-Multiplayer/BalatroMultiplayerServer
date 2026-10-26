import { Router } from 'express'
import adminRouter from '../features/admin/admin.route.js'
import { createAuthRouter } from '../features/auth/auth.route.js'
import { createAuthService } from '../features/auth/auth.service.js'
import blogRouter from '../features/blog/blog.route.js'
import launcherRouter from '../features/launcher/launcher.route.js'
import modsRouter from '../features/mods/mods.route.js'
import { createInternalNakamaRouter } from '../features/nakama/internal.route.js'
import r2modmanReleasesRouter from '../features/r2modman-releases/r2modman-releases.route.js'
import { createReplayLogRouter } from '../features/replay-log/replay-log.route.js'
import { replayLogService } from '../features/replay-log/replay-log.service.js'
import { createReportsRouter } from '../features/reports/reports.route.js'
import statsRouter from '../features/stats/stats.route.js'
import webadminRouter from '../features/webadmin/webadmin.route.js'
import * as playerGateway from '../infrastructure/gateways/player.gateway.js'
import { acceptNakamaNotice, deleteNakamaAccount } from '../infrastructure/nakama/profile-sync.js'

export const authService = createAuthService({
	playerRepository: playerGateway,
	nakamaAccounts: { delete: deleteNakamaAccount, acceptNotice: acceptNakamaNotice },
})

const router = Router()

router.use('/api/auth', createAuthRouter(authService))
router.use('/api/reports', createReportsRouter())
router.use('/api/runs', createReplayLogRouter(replayLogService))
router.use('/api/stats', statsRouter)
router.use('/api/launcher', launcherRouter)
router.use('/api/blog', blogRouter)
router.use('/api/mods', modsRouter)
router.use('/api/r2modman/updates', r2modmanReleasesRouter)
router.use('/api/webadmin', webadminRouter)
router.use('/admin', adminRouter)
router.use('/internal/nakama', createInternalNakamaRouter())

export default router
