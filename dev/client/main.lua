-- The Dev mod: points MultiplayerAPI at a Dev server and picks the account
-- the game logs in as, from environment variables. It reaches MPAPI only
-- through the MPAPI.dev seam (BalatroMultiplayerAPI api/dev.lua). It loads
-- after MPAPI (higher priority number) and before MPAPI connects (MPAPI
-- connects once Steam is up, after every mod has loaded).
--
--   BMP_SERVER_HOST, BMP_SERVER_PORT  use this server instead of the Dev
--                                     server at 127.0.0.1:7350
--   BMP_IMPERSONATE_ID=<id>           log in as this test account
--   BMP_IMPERSONATE_NAME=<name>       (Device login; ID wins over NAME)
--   BMP_DEV_STEAM_LOGIN=1             log in with Steam login (the server
--                                     needs a Steam Web API key)
if not (MPAPI and MPAPI.dev) then
	if MPAPI then
		MPAPI.sendWarnMessage('Dev mod: this MultiplayerAPI has no MPAPI.dev; the Dev mod does nothing.')
	end
	return
end

local host = os.getenv('BMP_SERVER_HOST')
if host then
	-- Only host and port: secure, server key and web URL stay MPAPI's.
	MPAPI.dev.set_server_defaults({ host = host, port = tonumber(os.getenv('BMP_SERVER_PORT')) })
else
	-- The Dev server from compose.local.yml. 127.0.0.1, not localhost:
	-- Windows tries IPv6 first and stalls against a server inside WSL2.
	MPAPI.dev.set_server_defaults({
		host = '127.0.0.1',
		port = 7350,
		secure = false,
		server_key = 'defaultkey',
		web_url = 'http://127.0.0.1:3000',
	})
end

local imp_id = os.getenv('BMP_IMPERSONATE_ID')
local imp_name = os.getenv('BMP_IMPERSONATE_NAME')
if os.getenv('BMP_DEV_STEAM_LOGIN') == '1' then
	if imp_id or imp_name then
		MPAPI.sendWarnMessage('Dev mod: BMP_DEV_STEAM_LOGIN=1 is set, so BMP_IMPERSONATE_* is ignored.')
	end
	MPAPI.dev.set_identity({ steam = true })
	MPAPI.sendDebugMessage('Dev mod: Steam login')
elseif imp_id or imp_name then
	MPAPI.dev.set_identity(imp_id and { id = imp_id } or { name = imp_name })
	MPAPI.sendDebugMessage('Dev mod: logging in as test account ' .. tostring(imp_id or imp_name))
end

MPAPI.sendDebugMessage('Dev mod: server ' .. tostring(host or '127.0.0.1'))
