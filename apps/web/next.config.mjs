/** @type {import("next").NextConfig} */
const config = {
  output: 'standalone',
  async redirects() {
    return [
      { source: '/leaderboard', destination: '/leaderboards', permanent: true },
      { source: '/account', destination: '/profile', permanent: false },
      // Retired admin pages: reports and match conflicts are queue items now.
      {
        source: '/admin/moderation/:reportId?',
        destination: '/admin/service-queue?type=report',
        permanent: false,
      },
      {
        source: '/admin/match-conflicts',
        destination: '/admin/service-queue?type=match_conflict',
        permanent: false,
      },
    ]
  },
}

export default config
