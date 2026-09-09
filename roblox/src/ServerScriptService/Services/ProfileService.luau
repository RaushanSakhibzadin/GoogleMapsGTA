--!strict
-- Player profiles: money now, the service record and unlocks later.
--
-- SESSION LOCKING IS NOT OPTIONAL. Roblox routinely has the same user in two
-- servers at once for a moment -- a teleport, a rejoin during a shutdown, a
-- flaky connection -- and two servers both holding an unlocked profile is how
-- money gets duplicated. The lock is a jobId written into the document with a
-- heartbeat; another server may steal it only after the heartbeat has been
-- stale for STEAL_AFTER, which covers a crash without covering a live session.
--
-- THE WRITE CADENCE IS THE OTHER HALF. DataStore allows about 60 + 10 per
-- player requests a minute and throttles a key written more than once every six
-- seconds. A write per payout at forty players would throttle and silently lose
-- data. So: read on join, write every SAVE_EVERY seconds if dirty, on leave,
-- and on BindToClose -- never per transaction.
--
-- ONE WRITER FOR MONEY. Everything that pays goes through award() here. The
-- plan says so and it is worth keeping to: the moment two places can add money
-- is the moment a duplication bug has two places to hide.

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ProfileService = {}

local VERSION = 1
local KEY = "profile_v1"
local SAVE_EVERY = 60
local LOCK_REFRESH = 30
local STEAL_AFTER = 120

export type Settings = {
	volume: { [string]: number },
	revSteer: boolean,
}

export type Profile = {
	version: number,
	money: number,
	resolved: { [string]: number },
	settings: Settings,
	lock: string?,
	lockAt: number?,
}

-- SAME DEFAULTS Shared/Audio.luau BOOTS WITH, and the same default the browser
-- game's own REV_REAL has (js/entities.js) -- a fresh profile should sound and
-- steer exactly like a client that has never opened the settings panel, not
-- like one that opened it and picked these.
local function blankSettings(): Settings
	return {
		volume = { Master = 1, Engine = 1, Effects = 0.5, Interface = 0.6 },
		revSteer = false,
	}
end

local function blank(): Profile
	return { version = VERSION, money = 0, resolved = {}, settings = blankSettings() }
end

-- STUDIO WITHOUT API ACCESS HAS NO DATASTORE, and that is the normal case while
-- this is being built. Rather than erroring on every join, the store falls back
-- to memory and says so once -- the game is identical, it just forgets.
local store: DataStore? = nil
local persistent = false
do
	local ok, result = pcall(function()
		return DataStoreService:GetDataStore("ViceRoblox")
	end)
	if ok and result then
		store = result
		persistent = true
	else
		warn("[profiles] no DataStore access -- profiles are in memory only for this session")
	end
end

local loaded: { [number]: Profile } = {}
local dirty: { [number]: boolean } = {}

ProfileService.changed = Instance.new("BindableEvent")

local function keyFor(userId: number): string
	return KEY .. "_" .. userId
end

-- SAME BACKWARD-COMPATIBLE SHAPE as money/resolved below: a profile written
-- before settings existed comes back without the field, and one written after
-- only three volume groups existed comes back missing the fourth -- either
-- way, fill the gap from blankSettings() rather than error on it or silently
-- drop whatever the profile did have.
local function withDefaultSettings(saved: Settings?): Settings
	local defaults = blankSettings()
	if not saved then
		return defaults
	end
	local volume = table.clone(defaults.volume)
	if saved.volume then
		for group, v in saved.volume do
			volume[group] = v
		end
	end
	return {
		volume = volume,
		revSteer = if saved.revSteer ~= nil then saved.revSteer else defaults.revSteer,
	}
end

function ProfileService.load(player: Player)
	local userId = player.UserId
	if not persistent or not store then
		loaded[userId] = blank()
		ProfileService.changed:Fire(player, loaded[userId])
		return
	end

	local jobId = game.JobId ~= "" and game.JobId or "studio"
	local ok, err = pcall(function()
		(store :: DataStore):UpdateAsync(keyFor(userId), function(old: Profile?)
			local p: Profile = old or blank()
			-- Somebody else's lock, and recent enough to be alive: refuse.
			-- Returning nil from UpdateAsync cancels the write.
			if p.lock and p.lock ~= jobId and (os.time() - (p.lockAt or 0)) < STEAL_AFTER then
				return nil
			end
			p.lock = jobId
			p.lockAt = os.time()
			p.version = VERSION
			p.money = p.money or 0
			p.resolved = p.resolved or {}
			p.settings = withDefaultSettings(p.settings)
			loaded[userId] = p
			return p
		end)
	end)

	if not ok or not loaded[userId] then
		warn(("[profiles] could not lock %s (%s) -- in memory for this session")
			:format(player.Name, tostring(err)))
		loaded[userId] = blank()
	end
	ProfileService.changed:Fire(player, loaded[userId])
end

function ProfileService.get(userId: number): Profile?
	return loaded[userId]
end

-- THE ONLY PLACE MONEY IS ADDED.
function ProfileService.award(player: Player, amount: number, why: string)
	local p = loaded[player.UserId]
	if not p or amount <= 0 then
		return
	end
	p.money += amount
	p.resolved[why] = (p.resolved[why] or 0) + 1
	dirty[player.UserId] = true
	ProfileService.changed:Fire(player, p)
end

-- THE FOUR GROUPS Shared/Audio.luau MIXES, kept as a small local list rather
-- than a require of a client-side module -- the server has no SoundGroups of
-- its own to drive, it only needs to know which keys of a settings patch are
-- real so a stray or malicious FireServer cannot grow the table forever.
local VOLUME_GROUPS = { Master = true, Engine = true, Effects = true, Interface = true }

-- WHATEVER THE SETTINGS PANEL CHANGED, applied and marked dirty the same way
-- award() marks money dirty -- picked up by the same periodic save, not
-- written per-toggle, for the same six-second-throttle reason the header
-- above explains.
function ProfileService.setSettings(player: Player, patch: { volume: { [string]: number }?, revSteer: boolean? })
	local p = loaded[player.UserId]
	if not p then
		return
	end
	if patch.volume then
		for group, v in patch.volume do
			if VOLUME_GROUPS[group] and type(v) == "number" then
				p.settings.volume[group] = math.clamp(v, 0, 1)
			end
		end
	end
	if patch.revSteer ~= nil then
		p.settings.revSteer = patch.revSteer == true
	end
	dirty[player.UserId] = true
	ProfileService.changed:Fire(player, p)
end

local function save(userId: number, release: boolean)
	local p = loaded[userId]
	if not p or not persistent or not store then
		return
	end
	if not dirty[userId] and not release then
		return
	end
	dirty[userId] = false
	local jobId = game.JobId ~= "" and game.JobId or "studio"
	pcall(function()
		(store :: DataStore):UpdateAsync(keyFor(userId), function(old: Profile?)
			-- Do not stamp over a server that has legitimately taken the lock.
			if old and old.lock and old.lock ~= jobId then
				return nil
			end
			p.lockAt = os.time()
			if release then
				p.lock = nil
			end
			return p
		end)
	end)
end

function ProfileService.unload(player: Player)
	local userId = player.UserId
	save(userId, true)
	loaded[userId] = nil
	dirty[userId] = nil
end

-- The cadence loop: a periodic dirty-write and a lock heartbeat, both well
-- inside the six-second per-key throttle.
task.spawn(function()
	local t = 0
	while true do
		task.wait(5)
		t += 5
		if t % SAVE_EVERY == 0 or t % LOCK_REFRESH == 0 then
			for userId in loaded do
				save(userId, false)
			end
		end
	end
end)

game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		ProfileService.unload(player)
	end
	if not RunService:IsStudio() then
		task.wait(1)
	end
end)

return ProfileService
