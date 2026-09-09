--!strict
-- THE CONSEQUENCE LAYER: car damage, a wanted level, a pursuit, and where you
-- wake up. Ported from js/game.js's hurtPlayer/addWanted/updateCop/busted/
-- wasted -- same constants, same shapes, where this port's own architecture
-- lets them cross over unchanged, and a documented departure where it can't.
--
-- REFRAMED, NOT REBUILT. ROBLOX_PORT_PLAN.md forbids vehicle wreck/explosion
-- and a player death screen; the plan this file was written against resolves
-- that by keeping the star count and the "you ran out of health" outcome but
-- narrating the second one honestly -- nobody dies, a car takes damage and its
-- driver wakes up at the nearest hospital. `wasted()`'s browser text and
-- colours are gone; the mechanic underneath (all the cash, a respawn, a
-- 2.2 s hold) is not.
--
-- SERVER-AUTHORITATIVE WHERE MONEY AND STATE CHANGE, exactly the split
-- VehicleServer.server.luau's own header draws for position: hp and the star
-- count live here, not on the client, because both end in either taking your
-- money or moving your car. Two of the four things that raise them are
-- self-reported by the client and only sanity-checked here (a building hit,
-- a traffic hit) for the same reason VehicleServer only sanity-checks
-- position -- buildings and traffic are simulated per-client with no shared
-- state to check against, and Life.client.luau's own header already says
-- this plainly for the pedestrian case: "a client saying 'I ran somebody
-- over' is a client saying anything it likes." What is NOT self-reported is
-- everything a police pursuit decides: the cop cars themselves are simulated
-- here, not on the client that is running from them, because that is the one
-- source of truth actually worth protecting -- a modified client cannot
-- simply stop being caught.
--
-- WHAT THIS DELIBERATELY DOES NOT PORT, and why: vehicle wreck/explosion for
-- traffic or the pursuit cars (ROBLOX_PORT_PLAN.md's own ban, and this port
-- has no HP/damage model for an AI car to begin with -- see Traffic.luau's
-- own Npc type); a "busted" arrest animation (the plan's revision explicitly
-- named this as skipped); cop-vs-traffic collision (traffic is simulated
-- independently per client and a cop simulated once, here, has no traffic to
-- collide with); the siren cue and the "panic" reaction from nearby traffic
-- (flavour, not the mechanic). Vehicle MASS scaling ("heft" in js/game.js,
-- which makes a heavier shift take less damage from a traffic hit) has
-- nothing to read here either -- Roles.luau has no per-shift mass field, only
-- Shared/PlayerCar.MASS, one constant for every shift -- so traffic damage is
-- flat across shifts; the armour multiplier below still applies and still
-- makes a police shift meaningfully tougher.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Roles = require(Shared:WaitForChild("Roles"))
local VehicleModel = require(Shared:WaitForChild("VehicleModel"))
local BuildingCollide = require(Shared:WaitForChild("BuildingCollide"))
local Traffic = require(Shared:WaitForChild("Traffic"))
local Streets = require(Shared:WaitForChild("Streets"))
local Depots = require(Shared:WaitForChild("Depots"))
local CarBuild = require(Shared:WaitForChild("CarBuild"))
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))

local RoleService = require(script.Parent:WaitForChild("RoleService"))
local ProfileService = require(script.Parent:WaitForChild("ProfileService"))

local WantedService = {}

local S = Meta.studsPerMetre

-- ---------------------------------------------------------------- constants

-- js/game.js:907-908,952,972-974. Metres, seconds, points of hp -- the same
-- units VehicleModel already works in, so every one of these is the browser's
-- own number, unconverted.
local BLD_MIN, BLD_MAX = 9, 26
local TRAFFIC_MAX, COP_MAX = 18, 12
local WANTED_HIT, WANTED_HIT_COP = 18, 12
local REGEN_AFTER, REGEN_RATE, REGEN_CAP = 7, 3.5, 65

-- js/game.js:2490,2495,2498,2506 -- decay, the cull radius, the near-cop
-- radius that gates decay, and the count a wanted level is stocked to.
local NEAR_COP = 130
local CULL_COP = 700
local COOL_DECAY = 8
local COP_TOP_UP_BACKOFF = 0.5

-- js/game.js:2485,2487 -- how close and how stationary a bust needs both cars.
local BUST_DIST, BUST_SPEED, BUST_HOLD = 8, 3, 1.6

-- js/game.js:2473-2474,2479. A COP CAR IS SIMULATED HERE AS A CIRCLE, not the
-- full eight-corner box VehicleModel's own body is -- this file has no
-- server-side reading of the PLAYER's own heading (VehicleServer.server.luau
-- keeps one but it is not a requirable module, and re-deriving it from the
-- car model's CFrame is one more sign convention to get wrong for a check
-- that only ever needs "are these two touching"). A little over two cars'
-- combined half-diagonal is close enough for that question without it.
local COP_HIT_RADIUS = 4.5
local COP_HIT_COOLDOWN = 0.6

-- js/game.js:2152 -- the hold on the "down" screen before doRespawn.
local DOWN_SECS = 2.2

-- A hit report or a pedestrian report this often at most, per player -- cheap
-- insurance against a stray or hostile FireServer loop, not an attempt to
-- outguess a client about whether a hit was real (see the header above).
local REPORT_MIN_GAP = 0.15

export type Cop = {
	id: number,
	car: VehicleModel.Car,
}

type PState = {
	model: Model,
	hp: number,
	calm: number,
	wanted: number,
	cool: number,
	bustT: number,
	cops: { Cop },
	nextCopId: number,
	copCd: number,
	copHitCd: number,
	down: boolean,
	downReason: string,
	downFine: number, -- only meaningful the instant downReason becomes "busted"
	lastX: number,
	lastY: number,
	lastHurtAt: number,
	lastPedAt: number,
}

local state: { [Player]: PState } = {}

-- (player, {hp, wanted, down, reason}) -- every time any of the first three
-- changes. `reason` only means anything the instant `down` turns true; a
-- companion server script uses it to pick which banner to show.
WantedService.changed = Instance.new("BindableEvent")
-- (player, x, y, h) -- fired once a "down" hold ends and the car has already
-- been moved, so the companion script can force the client's own copy of the
-- car to the same place through CarCorrection, the same way a rejected
-- CarState report already does.
WantedService.respawned = Instance.new("BindableEvent")

local function snapshot(s: PState)
	return { hp = s.hp, wanted = s.wanted, down = s.down, reason = s.downReason, fine = s.downFine }
end

-- ---------------------------------------------------------------- respawn

-- Where you wake up. Depots.luau is the same static list RoleService reads,
-- in STUDS (it is compared against a model's own Position elsewhere); the
-- rest of this file works in the METRES VehicleModel and CarBuild.place both
-- use, so the conversion happens once, on the way out.
local RECOVER_KIND = { police = "police", hospital = "clinic" } -- js/Roles.luau's own finding: no amenity=hospital in this capture

local function nearestDepot(kind: string, xs: number, zs: number): { x: number, z: number, gx: number?, gz: number? }?
	local best, bestD2 = nil, math.huge
	for _, d in Depots :: { any } do
		if d.kind == kind then
			local dx, dz = d.x - xs, d.z - zs
			local d2 = dx * dx + dz * dz
			if d2 < bestD2 then
				bestD2, best = d2, d
			end
		end
	end
	return best
end

-- The gate, facing away from the building and onto the road it sits by --
-- cheap to compute from data already there, and it means a respawned car
-- does not open its eyes staring at a wall.
local function recoverPoint(model: Model, kind: string): (number, number, number)
	local p = model:GetPivot().Position
	local depot = nearestDepot(RECOVER_KIND[kind] or kind, p.X, p.Z)
	if not depot then
		-- Genuinely possible for some kinds in some districts -- this one just
		-- is not one of them, since "police" and "clinic" both exist here.
		-- Waking up where you already are is the honest fallback, not a wrong
		-- guess about where the world's edge is.
		return p.X / S, p.Z / S, 0
	end
	local gx = depot.gx or depot.x
	local gz = depot.gz or depot.z
	local h = if depot.gx then math.atan2(gz - depot.z, gx - depot.x) else 0
	return gx / S, gz / S, h
end

-- ---------------------------------------------------------------- attach

function WantedService.attach(player: Player, model: Model)
	local p = model:GetPivot().Position
	state[player] = {
		model = model,
		hp = 100,
		calm = 0,
		wanted = 0,
		cool = 0,
		bustT = 0,
		cops = {},
		nextCopId = 0,
		copCd = 0,
		copHitCd = 0,
		down = false,
		downReason = "",
		downFine = 0,
		lastX = p.X / S,
		lastY = p.Z / S,
		lastHurtAt = 0,
		lastPedAt = 0,
	}
end

function WantedService.detach(player: Player)
	state[player] = nil
end

-- WHETHER VehicleServer.server.luau SHOULD BELIEVE A POSITION REPORT.
--
-- Found by testing, not anticipated: beginDown moves the car once, but
-- VehicleController.client.luau's own CarState loop does not know a hold is
-- in progress -- it only stops STEERING while ClientBus.down is true (see its
-- own comment on why) -- and kept sending the car's last real position every
-- 1/15 s regardless. The very next one of those arriving at
-- VehicleServer.server.luau, which had no way to know better, overwrote the
-- relocation within a frame of it happening. VehicleController now skips the
-- send on its side while down (see its own note); this is the belt to that
-- brace, and the one that actually matters -- a client is never required to
-- honour ClientBus.down, only expected to.
function WantedService.isDown(player: Player): boolean
	local s = state[player]
	return s ~= nil and s.down
end

function WantedService.snapshotFor(player: Player)
	local s = state[player]
	return if s then snapshot(s) else nil
end

function WantedService.copsFor(player: Player): { Cop }
	local s = state[player]
	return if s then s.cops else {}
end

-- ---------------------------------------------------------------- damage

-- EVERY POINT OF DAMAGE GOES THROUGH HERE, same rule as js/game.js's own
-- hurtPlayer -- one door, so "what is killing me" and "does a police shift
-- take less of it" are both answered in one place.
local function hurt(player: Player, s: PState, n: number)
	if n <= 0 or s.down then
		return
	end
	local armour = Roles.get(RoleService.roleOf(player.UserId)).armour
	s.hp -= n * armour
	s.calm = 0
	if s.hp <= 0 then
		s.hp = 0
		WantedService.wasted(player)
	else
		WantedService.changed:Fire(player, snapshot(s))
	end
end

-- js/game.js:1998-2021. Refused outright on a police shift -- ramming the car
-- you were sent to stop must not earn a star, and neither may any of the
-- other four ways of raising one, so the refusal lives here rather than as an
-- exception on each of them.
function WantedService.addWanted(player: Player, n: number)
	local s = state[player]
	if not s or s.down then
		return
	end
	if RoleService.roleOf(player.UserId) == "police" then
		if s.wanted > 0 or #s.cops > 0 then
			s.wanted, s.cool, s.bustT, s.cops = 0, 0, 0, {}
			WantedService.changed:Fire(player, snapshot(s))
		end
		return
	end
	local before = s.wanted
	s.wanted = math.clamp(s.wanted + n, 0, 5)
	s.cool = 0
	if s.wanted > before then
		WantedService.changed:Fire(player, snapshot(s))
	end
end

-- WHATEVER THE CLIENT SAYS HAPPENED, sanity-checked and rate-limited but not
-- otherwise doubted -- see the header. `why` is "bld" or "traffic"; `rel` is
-- the closing speed the client's own physics measured, in the same m/s
-- VehicleModel already works in.
function WantedService.reportImpact(player: Player, why: string, rel: number)
	local s = state[player]
	if not s or s.down then
		return
	end
	if (why ~= "bld" and why ~= "traffic") or typeof(rel) ~= "number" or rel ~= rel or rel < 0 then
		return
	end
	local now = os.clock()
	if now - s.lastHurtAt < REPORT_MIN_GAP then
		return
	end
	s.lastHurtAt = now
	if why == "bld" then
		if rel <= BLD_MIN then
			return
		end
		hurt(player, s, math.clamp((rel - BLD_MIN) * 1.5, 0, BLD_MAX))
	else
		if rel <= 6 then
			return
		end
		hurt(player, s, math.clamp(rel * 0.7, 0, TRAFFIC_MAX))
		if rel > WANTED_HIT then
			WantedService.addWanted(player, 0.34)
		end
	end
end

-- js/game.js:2450-2454 -- addWanted(1) flat, no hp cost (a pedestrian is not
-- a wall). `spd` is the reporting client's own speed at the moment of the
-- knock, which js/game.js's own trigger requires be above 4 m/s -- checked
-- again here rather than trusted, same as everything else in this function.
function WantedService.reportPedHit(player: Player, spd: number)
	local s = state[player]
	if not s or s.down then
		return
	end
	if typeof(spd) ~= "number" or spd ~= spd or spd < 4 then
		return
	end
	local now = os.clock()
	if now - s.lastPedAt < REPORT_MIN_GAP then
		return
	end
	s.lastPedAt = now
	WantedService.addWanted(player, 1)
end

-- ---------------------------------------------------------------- down

-- THE HOLD, then the move. js/game.js keeps `respawn()` (arm the hold) and
-- `doRespawn()` (actually move the car once it elapses) apart for the same
-- reason this does: the car has to stay exactly where it went wrong for the
-- 2.2 s the banner is up, or the moment that mattered is gone before the
-- player has read what happened.
local function beginDown(player: Player, s: PState, reason: string, recoverKind: string)
	if s.down then
		return
	end
	s.down = true
	s.downReason = reason
	s.wanted, s.cool, s.bustT, s.cops = 0, 0, 0, {}
	WantedService.changed:Fire(player, snapshot(s))
	task.delay(DOWN_SECS, function()
		-- The player may have left, or a fresh car may have replaced this one,
		-- in the 2.2 s this was waiting -- state[player] no longer being this
		-- exact table covers both.
		if state[player] ~= s then
			return
		end
		local x, y, h = recoverPoint(s.model, recoverKind)
		CarBuild.place(s.model, x, y, h, s.model:GetAttribute("BodyY") :: number?)
		s.hp = 100
		s.calm = 0
		s.down = false
		s.downReason = ""
		s.downFine = 0
		s.lastX, s.lastY = x, y
		WantedService.changed:Fire(player, snapshot(s))
		WantedService.respawned:Fire(player, x, y, h)
	end)
end

-- js/game.js:2132-2150, reframed per the plan's own revision: the browser's
-- WASTED banner and its "cleaned out" line describe a car stopping and a
-- driver being patched up, never a death, so the mechanic crosses over
-- whole -- all the cash, a hold, a wake-up at the nearest hospital -- and
-- only the presentation (ROBLOX_PORT_PLAN.md's own ban) is left behind.
function WantedService.wasted(player: Player)
	local s = state[player]
	if not s or s.down then
		return
	end
	local profile = ProfileService.get(player.UserId)
	if profile then
		ProfileService.spend(player, profile.money, "wasted")
	end
	beginDown(player, s, "wasted", "hospital")
end

-- js/game.js:2125-2131.
function WantedService.busted(player: Player)
	local s = state[player]
	if not s or s.down then
		return
	end
	local profile = ProfileService.get(player.UserId)
	-- SET BEFORE beginDown, which is what fires the snapshot the fine rides
	-- on -- the banner needs the number in the same message that says to
	-- show it, not a second one that might arrive first.
	s.downFine = if profile then ProfileService.spend(player, math.floor(profile.money / 2), "busted") else 0
	beginDown(player, s, "busted", "police")
end

-- ---------------------------------------------------------------- pursuit

-- SPAWNED ON A WIDENING RING AROUND THE PLAYER, never anywhere in the whole
-- district -- js/entities.js:511-524's own reasoning: a unit further out than
-- the cull radius (CULL_COP) is deleted the moment it is topped up, which
-- looked like it worked only because the old top-up ran every frame and
-- eventually rolled a near one.
local function trySpawnCop(s: PState, px: number, py: number): boolean
	local spot = Streets.roadPoint(px, py, 150, 320)
		or Streets.roadPoint(px, py, 90, 480)
		or Streets.roadPoint(px, py, 40, 660)
	if not spot then
		return false
	end
	local car = VehicleModel.newCar(spot.x, spot.y, spot.h)
	car.kind = "police"
	s.nextCopId += 1
	table.insert(s.cops, { id = s.nextCopId, car = car })
	return true
end

local function stockCops(s: PState, px: number, py: number, target: number): boolean
	local guard = 8
	while #s.cops < target and guard > 0 do
		guard -= 1
		if not trySpawnCop(s, px, py) then
			return false
		end
	end
	return true
end

-- js/game.js:2866-2907, minus the traffic/cop-on-cop damage js/entities.js's
-- own Npc has nothing to take (see the header) -- the wall push and the
-- speed shaping are the whole of what is left to port, and both are.
--
-- Returns the distance to the player and both cars' speed, which is what the
-- caller needs for the bust check right after this -- computed once, at the
-- position this car was in when the frame started, the same single
-- measurement updateCop itself takes.
local collisionFolder: Instance? = nil
local overlapParams = OverlapParams.new()
local boxesScratch = {}
local function stepCop(k: Cop, px: number, py: number, pvx: number, pvy: number, wanted: number, dt: number): (number, number, number)
	local c = k.car
	local prevX, prevY = c.x, c.y
	local d = math.sqrt((c.x - px) ^ 2 + (c.y - py) ^ 2)
	local pspd = math.sqrt(pvx * pvx + pvy * pvy)
	local kspd = math.sqrt(c.vx * c.vx + c.vy * c.vy)

	local want = math.atan2(py - c.y, px - c.x)
	local df = VehicleModel.angDiff(c.h, want)
	local holding = d < 9 and pspd < 4
	local gas = if holding then 0 elseif math.abs(df) < 1.5 or d > 30 then 1 else 0
	local brake = if holding
		then (if kspd > 1.2 then 1 else 0)
		else (if math.abs(df) > 2.2 and d < 20 then 1 else 0)

	-- Higher stars, faster units -- scaled off the player's own top speed, not
	-- a fixed one, and bounded by the CLOSING speed so a unit converging on a
	-- target doing nothing does not arrive doing eighty. js/game.js:2887-2898.
	c.maxSpeed = VehicleModel.TOP_SPEED * (0.52 + wanted * 0.096)
	c.maxSpeed = math.min(c.maxSpeed, pspd + 12 + d * 0.55)
	if pspd < 4 and d < 50 then
		c.maxSpeed = math.max(7, d * 0.45)
	end

	VehicleModel.step(c, { gas = gas, brake = brake, steer = math.clamp(df * 2.0, -1, 1), hand = 0, spinPress = false }, dt, nil, false)

	if not collisionFolder then
		collisionFolder = workspace:FindFirstChild("Collision")
		if collisionFolder then
			overlapParams.FilterDescendantsInstances = { collisionFolder :: Instance }
		end
	end
	if collisionFolder then
		BuildingCollide.near(c.x, c.y, 12, S, overlapParams, boxesScratch)
		BuildingCollide.resolve(c, boxesScratch, prevX, prevY)
	end

	return d, pspd, kspd
end

-- ---------------------------------------------------------------- the tick

-- 15 Hz, the same rate Traffic.step runs its own AI at client-side -- a
-- pursuit car is not drawn here, only simulated, so there is nothing this
-- needs sixty answers a second for.
function WantedService.step(dt: number)
	for player, s in state do
		if s.down or not s.model.Parent then
			continue
		end

		s.calm += dt
		if s.calm > REGEN_AFTER and s.hp > 0 and s.hp < REGEN_CAP then
			s.hp = math.min(REGEN_CAP, s.hp + REGEN_RATE * dt)
		end

		local p = s.model:GetPivot().Position
		local px, py = p.X / S, p.Z / S
		-- A SERVER-SIDE ESTIMATE of the player's own velocity, from how far
		-- their car moved since the last tick. VehicleServer's own state does
		-- not keep this (position and a timestamp is all the anti-cheat check
		-- needs), and asking for it there would be a second file learning
		-- about pursuits; a finite difference over 1/15 s is more than close
		-- enough for AI steering and a stationary-or-not bust check, which is
		-- all it is used for.
		local pvx, pvy = (px - s.lastX) / dt, (py - s.lastY) / dt
		s.lastX, s.lastY = px, py

		if s.wanted > 0 then
			local nearCop = false
			for _, k in s.cops do
				if (k.car.x - px) ^ 2 + (k.car.y - py) ^ 2 < NEAR_COP * NEAR_COP then
					nearCop = true
					break
				end
			end
			if nearCop then
				s.cool = 0
			else
				s.cool += dt
				if s.cool > COOL_DECAY then
					s.cool = 0
					s.wanted = math.max(0, s.wanted - 1)
					if s.wanted == 0 then
						s.cops = {}
					end
					WantedService.changed:Fire(player, snapshot(s))
				end
			end

			-- Cull whatever fell hopelessly behind, then top back up to the
			-- level the wanted count wants. js/game.js:2497-2507.
			local kept = {}
			for _, k in s.cops do
				local dx, dy = k.car.x - px, k.car.y - py
				if dx * dx + dy * dy < CULL_COP * CULL_COP then
					table.insert(kept, k)
				end
			end
			s.cops = kept

			s.copCd = math.max(0, s.copCd - dt)
			local want = math.floor(s.wanted * 1.6 + 0.5)
			if s.copCd <= 0 and #s.cops < want then
				if not stockCops(s, px, py, want) then
					s.copCd = COP_TOP_UP_BACKOFF
				end
			end

			-- Every cop this tick, and the closest approach of any of them --
			-- what the bust check right after needs. One accumulation of
			-- bustT per QUALIFYING FRAME rather than once per qualifying cop:
			-- js/game.js's own loop adds it once per cop that qualifies in the
			-- same frame, which makes being boxed in by several of them bust
			-- you measurably faster than one -- an artefact of where the
			-- check sits in that loop, not a deliberately designed feel, and
			-- not one worth reproducing on purpose.
			local bestD, bestPspd, bestKspd, nearest = math.huge, 0, 0, nil
			for _, k in s.cops do
				local d, pspd, kspd = stepCop(k, px, py, pvx, pvy, s.wanted, dt)
				if d < bestD then
					bestD, bestPspd, bestKspd, nearest = d, pspd, kspd, k
				end
			end
			for i, ka in s.cops do
				for j = i + 1, #s.cops do
					Traffic.collide(ka.car, 3, s.cops[j].car, 3)
				end
			end

			-- RAMMING A COP, js/game.js:2466-2480. Rate-limited the same 0.6 s
			-- as the traffic case, and against a circle rather than the full
			-- eight-corner box -- see COP_HIT_RADIUS's own note on why. `rel`
			-- is the magnitude of the two cars' relative velocity at contact,
			-- which is not identical to carsCollide's along-the-contact-normal
			-- number but reads the same way against these thresholds: near
			-- zero nose-to-tail in the chase, large on an actual ram.
			s.copHitCd = math.max(0, s.copHitCd - dt)
			if nearest and bestD < COP_HIT_RADIUS and s.copHitCd <= 0 then
				local c = (nearest :: Cop).car
				local relvx, relvy = c.vx - pvx, c.vy - pvy
				local rel = math.sqrt(relvx * relvx + relvy * relvy)
				if rel > 5 then
					s.copHitCd = COP_HIT_COOLDOWN
					hurt(player, s, math.clamp(rel * 0.5, 0, COP_MAX))
					if rel > WANTED_HIT_COP then
						WantedService.addWanted(player, 0.22)
					end
				end
			end

			if bestD < BUST_DIST and bestPspd < BUST_SPEED and bestKspd < BUST_SPEED and s.wanted >= 1 then
				s.bustT += dt
				if s.bustT > BUST_HOLD then
					WantedService.busted(player)
				end
			else
				s.bustT = 0
			end
		else
			s.bustT = 0
		end
	end
end

return WantedService
