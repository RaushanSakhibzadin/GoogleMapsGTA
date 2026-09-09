--!strict
-- THE PEOPLE. js/entities.js:makePed, walkPed, pedHold, knockPed and
-- stepDowned, ported in metres and seconds.
--
-- PURE, like Traffic: no Instances, no assumption about which side it runs on.
--
-- THEY WALK ON THE PAVEMENT, AND THE PAVEMENT IS A ROAD'S EDGE. A pedestrian is
-- bound to a way exactly the way traffic is -- it holds the road, the node it
-- is walking towards, and which way along -- and what makes it a pavement
-- rather than a lane is one number: the offset is the carriageway's half width
-- plus a metre and a half. A wide boulevard puts them further out than a back
-- street without anything having to know which is which.
--
-- The alternative, and what the browser did first, is a random walk with a rule
-- that reverses anyone who steps onto tarmac. That does nothing about the far
-- more common case of a walk that drifts steadily away from any street at all,
-- and after a minute the city has people standing in the middle of car parks
-- and out in open ground, facing nothing.
--
-- AT THE END OF A WAY THEY TURN ROUND rather than being re-homed. Re-homing is
-- a teleport, and a person vanishing from one pavement and appearing on another
-- is worse than a person walking back the way they came -- which is a thing
-- people actually do. The side flips at the same time, so they come back along
-- the other pavement instead of retracing the same line.
--
-- KNOCKED DOWN, AND THEN THEY GET UP. The browser leaves a body on the pavement
-- for twenty-two seconds and then culls it. That is not what this port is meant
-- to do: nobody dies here, so the timer ends in standing up and walking off
-- rather than in deletion.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Streets = require(Shared:WaitForChild("Streets"))

local Pedestrians = {}

Pedestrians.CAP = 34 -- the browser's number
Pedestrians.KEEP = 190 -- metres: culled beyond this
Pedestrians.RING = 40 -- metres: no closer than this to the player when spawned

-- m/s: the shove/throw threshold. About 32 km/h -- the speed at which being hit
-- by a car stops being a shove and starts being something that picks you up,
-- which is also roughly where the real injury curves turn.
local FLY_MIN = 9
local G = 17 -- gravity for a body, a shade brisk so it reads
local DOWN_SECS = 14 -- how long one stays down before getting up
local RISE_SECS = 1.1 -- and how long standing back up takes

export type Ped = {
	x: number,
	y: number,
	way: Streets.Way,
	idx: number,
	dir: number,
	side: number, -- which pavement: -1 or 1
	h: number, -- facing, radians
	spd: number, -- walking pace, m/s
	step: number, -- where in the stride, so a crowd is not one person copied
	shirt: Color3,
	trews: Color3,
	skin: Color3,
	-- ON THEIR FEET OR NOT. `lie` is how far over they have gone, in radians
	-- about their own lateral axis: 0 upright, pi/2 flat out, anything between
	-- while they are in the air or getting back up. Everything that DRAWS a
	-- person reads this one angle, so someone thrown by a van and someone
	-- picking themselves up are the same pose reached two different ways.
	lie: number,
	lieV: number,
	pz: number, -- height above the pavement
	pvx: number,
	pvy: number,
	pvz: number,
	struck: boolean,
	downT: number,
	-- Consecutive frames with nowhere clear to step. See the escape hatch in
	-- walk(): a person who cannot move for a second walks anyway.
	blocked: number,
	model: Instance?,
}

export type State = {
	peds: { Ped },
	topUp: number,
	gone: { Ped },
}

-- Clothes, not neon. The browser picked these from the same palette the cars
-- use, which is six fluorescent colours, and a person is not a car.
local CLOTH = {
	Color3.fromRGB(63, 74, 99),
	Color3.fromRGB(107, 63, 63),
	Color3.fromRGB(47, 86, 70),
	Color3.fromRGB(90, 74, 107),
	Color3.fromRGB(122, 106, 74),
	Color3.fromRGB(64, 80, 107),
	Color3.fromRGB(138, 74, 85),
	Color3.fromRGB(58, 63, 74),
	Color3.fromRGB(107, 90, 63),
	Color3.fromRGB(74, 107, 99),
}
local SKIN = {
	Color3.fromRGB(240, 201, 166),
	Color3.fromRGB(217, 168, 120),
	Color3.fromRGB(176, 125, 82),
	Color3.fromRGB(138, 90, 56),
	Color3.fromRGB(94, 58, 36),
	Color3.fromRGB(245, 221, 192),
}

local function pick<T>(t: { T }): T
	return t[math.random(1, #t)]
end

local function rand(a: number, b: number): number
	return a + math.random() * (b - a)
end

function Pedestrians.new(): State
	return { peds = {}, topUp = 0, gone = {} }
end

-- ---------------------------------------------------------------- spawning

function Pedestrians.spawn(state: State, px: number, py: number, count: number)
	for _ = 1, count do
		local p = Streets.roadPoint(px, py, Pedestrians.RING, Pedestrians.KEEP - 10)
		if not p then
			continue
		end
		local spot = p :: Streets.Spot
		local side = if math.random() < 0.5 then -1 else 1
		local dir = if math.random() < 0.5 then 1 else -1
		local wx, wy = Streets.pedWalkPoint(spot.way, spot.idx, dir, side)
		table.insert(state.peds, {
			x = wx or spot.x,
			y = wy or spot.y,
			way = spot.way,
			idx = spot.idx,
			dir = dir,
			side = side,
			h = 0,
			spd = rand(1.0, 1.7),
			step = math.random() * math.pi * 2,
			shirt = pick(CLOTH),
			trews = pick(CLOTH),
			skin = pick(SKIN),
			lie = 0,
			lieV = 0,
			pz = 0,
			pvx = 0,
			pvy = 0,
			pvz = 0,
			struck = false,
			downT = 0,
			blocked = 0,
			model = nil,
		})
	end
end

-- ---------------------------------------------------------------- the walk

-- AND THE PAVEMENT IS HELD TO, not merely aimed at.
--
-- Walking towards an offset node keeps them beside the road on a straight and
-- cuts the corner on a bend: the straight line between two pavement points
-- either side of a bend passes INSIDE it, and inside a bend is the
-- carriageway. So the lateral position is corrected against the segment they
-- are actually on -- and only when they have ended up on the tarmac, so a walk
-- down a straight is untouched and this costs one projection a frame for the
-- few who need it.
--
-- EVERY SEGMENT OF THE WAY, not the one behind them, which is the wrong one at
-- exactly the place this exists for: coming into the inside of a bend they are
-- comfortably clear of the segment behind and standing well inside the
-- carriageway of the one ahead. Twice, because stepping out of one leg of a
-- hairpin can land in the other; a third pass never fired on any road measured.
local function pedHold(p: Ped)
	local r = p.way
	local n = Streets.nodeCount(r)
	if n < 2 then
		return
	end
	local half = (if r.w > 0 then r.w else 6) * 0.5
	local want = Streets.pedOffset(r)
	for _ = 1, 2 do
		local bl, bx, by, bnx, bny = math.huge, 0, 0, 0, 0
		for k = 1, n - 1 do
			local ax, ay = Streets.node(r, k)
			local cx, cy = Streets.node(r, k + 1)
			-- nothing outside the carriageway's own box can be within half of it
			if
				p.x < math.min(ax, cx) - half
				or p.x > math.max(ax, cx) + half
				or p.y < math.min(ay, cy) - half
				or p.y > math.max(ay, cy) + half
			then
				continue
			end
			local ex, ey = cx - ax, cy - ay
			local L2 = ex * ex + ey * ey
			if L2 < 1e-6 then
				continue
			end
			local t = math.clamp(((p.x - ax) * ex + (p.y - ay) * ey) / L2, 0, 1)
			local qx, qy = ax + ex * t, ay + ey * t
			local lat = math.sqrt((p.x - qx) ^ 2 + (p.y - qy) ^ 2)
			if lat >= bl then
				continue
			end
			local L = math.sqrt(L2)
			bl, bx, by = lat, qx, qy
			bnx, bny = -ey / L, ex / L
		end
		if bl >= half then
			return -- clear of every carriageway
		end
		-- out to the side they are already nearer, which is the pavement they
		-- were on
		local sgn = if (p.x - bx) * bnx + (p.y - by) * bny >= 0 then 1 else -1
		p.x = bx + bnx * want * sgn
		p.y = by + bny * want * sgn
	end
end

local function walk(p: Ped, dt: number)
	local qx, qy = Streets.pedWalkPoint(p.way, p.idx, p.dir, p.side)
	if not qx then
		return
	end
	local dx, dy = (qx :: number) - p.x, (qy :: number) - p.y
	local d = math.sqrt(dx * dx + dy * dy)
	if d < 1e-6 then
		d = 1e-6
	end
	if d < 1.2 then
		-- arrived: on to the next node, or turn round at the end
		local nodes = Streets.nodeCount(p.way)
		local nxt = p.idx + p.dir
		if nxt < 1 or nxt > nodes then
			p.dir = -p.dir
			p.side = -p.side -- back along the other pavement
			p.idx = math.clamp(p.idx + p.dir, 1, nodes)
		else
			p.idx = nxt
		end
		return
	end

	local stepLen = p.spd * dt
	local nx, ny = p.x + dx / d * stepLen, p.y + dy / d * stepLen

	-- AND THEY DO NOT WALK THROUGH BUILDINGS. A pavement offset from a
	-- centreline is right nearly everywhere and wrong where a footprint has been
	-- mapped over the verge -- measured on this district, 7.7% of pavement
	-- points are inside a real footprint -- so the far side is tried, which is
	-- what a person would do.
	--
	-- ALREADY INSIDE ONE IS THE OPPOSITE PROBLEM, and it has to be checked
	-- first. solidAt is tested one step AHEAD, so somebody who has ended up
	-- inside a footprint finds every direction blocked and can never leave: the
	-- rule that is meant to stop you entering imprisons you instead. Walking is
	-- the only way out, so they walk.
	if Streets.solidAt(p.x, p.y) then
		p.x, p.y = nx, ny
		pedHold(p)
		p.h = math.atan2(dy, dx)
		p.step += stepLen * 2.6
		p.blocked = 0
		return
	end

	-- AND THE FAR SIDE IS TESTED BEFORE IT IS TAKEN, which is the rest of it.
	-- Flipping blind is what the browser does, and where BOTH pavements are
	-- built over it flips back and forth for ever -- the walker stands still,
	-- swapping sides sixty times a second, until something culls them. The Node
	-- harness caught eight of thirty-four doing exactly that: 2,600 flips each
	-- in ninety seconds and not one of them a metre from where it started.
	--
	-- Where neither side is clear they walk PAST the obstruction instead,
	-- stepping the target on to the next node so the blocked stretch is skipped
	-- rather than stood in front of. And after a second of getting nowhere they
	-- simply go, because a person clipping a wall for a step is a smaller lie
	-- than a person frozen on the pavement for ever. With all three, no walker
	-- in the harness failed to move.
	if Streets.solidAt(nx, ny) then
		p.blocked += 1
		if p.blocked <= 30 then
			local ox, oy = Streets.pedWalkPoint(p.way, p.idx, p.dir, -p.side)
			if ox and not Streets.solidAt(ox :: number, oy :: number) then
				p.side = -p.side
				return
			end
			local nodes = Streets.nodeCount(p.way)
			local nxt = p.idx + p.dir
			if nxt < 1 or nxt > nodes then
				p.dir = -p.dir
				p.side = -p.side
				p.idx = math.clamp(p.idx + p.dir, 1, nodes)
			else
				p.idx = nxt
			end
			return
		end
	end

	p.blocked = 0
	p.x, p.y = nx, ny
	pedHold(p)
	p.h = math.atan2(dy, dx)
	p.step += stepLen * 2.6 -- about two paces a second at walking pace
end

-- ---------------------------------------------------------------- knocked down

-- Below a brisk speed they fold up where they stand; above it they are thrown
-- along the way the car was going and tumble while they go.
--
-- Thrown at a FRACTION of what hit them, not at all of it: a person is not a
-- billiard ball, and most of the energy goes into them rather than into moving
-- them.
function Pedestrians.knock(p: Ped, vx: number, vy: number, spd: number): boolean
	if p.struck then
		return false -- already down; a second wheel over them adds nothing
	end
	p.struck = true
	p.downT = DOWN_SECS
	local s = math.sqrt(vx * vx + vy * vy)
	if s < 1e-6 then
		s = 1
	end
	local fly = spd > FLY_MIN
	local k = if fly then 0.40 else 0.22
	p.pvx = vx / s * spd * k
	p.pvy = vy / s * spd * k
	p.pvz = if fly then 2.0 + math.min(spd, 30) * 0.16 else 0
	-- which way they go over, and how fast. A throw tumbles; a shove just folds.
	p.lieV = if fly then rand(2.6, 4.4) else rand(2.0, 3.0)
	return true
end

-- One step of being on the floor. Runs in place of the walk, so a body neither
-- strolls off nor stands up in the road it was knocked into.
local function down(p: Ped, dt: number)
	if p.downT > 0 then
		p.downT -= dt
	end
	if p.pz > 0 or p.pvz > 0 then
		p.pvz -= G * dt
		p.pz += p.pvz * dt
		p.x += p.pvx * dt
		p.y += p.pvy * dt
		p.lie += p.lieV * dt
		if p.pz <= 0 then
			-- Landed. FLAT, whichever way round the tumble left them: a body that
			-- came to rest at forty degrees is a body standing on its head.
			p.pz, p.pvz, p.lieV = 0, 0, 0
			p.pvx *= 0.10
			p.pvy *= 0.10
			p.lie = math.pi * 0.5
		end
		return
	end

	if p.downT <= 0 then
		-- GETTING UP, which is the whole difference between this and the browser.
		-- Nobody dies in this game, so the timer ends in standing rather than in
		-- being deleted -- and it is the same `lie` angle running the other way,
		-- so nothing that draws a person needs to know it is happening.
		p.lie -= (math.pi * 0.5 / RISE_SECS) * dt
		if p.lie <= 0 then
			p.lie = 0
			p.struck = false
			p.pvx, p.pvy = 0, 0
			-- Back onto whichever pavement they are nearest, facing along it.
			pedHold(p)
		end
		return
	end

	if p.lie < math.pi * 0.5 then
		p.lie = math.min(math.pi * 0.5, p.lie + p.lieV * dt)
	end
	-- whatever slide is left, bled off fast: tarmac is not ice
	p.x += p.pvx * dt
	p.y += p.pvy * dt
	local damp = 0.015 ^ dt
	p.pvx *= damp
	p.pvy *= damp
end

-- ---------------------------------------------------------------- the tick

-- `car` is the player's car, or nil. `onHit` is called with the pedestrian each
-- time one is knocked down, which is where a caller puts the sound, the toast
-- and -- eventually -- the infraction.
function Pedestrians.step(
	state: State,
	dt: number,
	px: number,
	py: number,
	car: { x: number, y: number, vx: number, vy: number }?,
	onHit: ((Ped, number) -> ())?
)
	table.clear(state.gone)

	local keep2 = Pedestrians.KEEP * Pedestrians.KEEP
	local i = 1
	while i <= #state.peds do
		local p = state.peds[i]
		-- SOMEBODY ON THE GROUND IS NOT CULLED, however far away you drive. A
		-- body that blinks out because you looked away is the thing this port is
		-- meant not to do; they are only ever removed once they are back on
		-- their feet.
		if not p.struck and (p.x - px) ^ 2 + (p.y - py) ^ 2 > keep2 then
			local last = #state.peds
			state.peds[i] = state.peds[last]
			state.peds[last] = nil
			table.insert(state.gone, p)
		else
			i += 1
		end
	end

	state.topUp -= dt
	if state.topUp <= 0 then
		state.topUp = 0.25
		if #state.peds < Pedestrians.CAP then
			Pedestrians.spawn(state, px, py, math.min(6, Pedestrians.CAP - #state.peds))
		end
	end

	local spd = 0
	if car then
		local c = car :: { x: number, y: number, vx: number, vy: number }
		spd = math.sqrt(c.vx * c.vx + c.vy * c.vy)
	end

	for _, p in state.peds do
		if p.struck then
			down(p, dt)
		else
			walk(p, dt)
		end
		if car and not p.struck then
			local c = car :: { x: number, y: number, vx: number, vy: number }
			-- The browser's test exactly: within about 2.2 m, and moving. Standing
			-- still against somebody is not running them over.
			if (p.x - c.x) ^ 2 + (p.y - c.y) ^ 2 < 5 and spd > 4 then
				if Pedestrians.knock(p, c.vx, c.vy, spd) and onHit then
					(onHit :: (Ped, number) -> ())(p, spd)
				end
			end
		end
	end
end

return Pedestrians
