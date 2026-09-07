--!strict
-- THE OTHER CARS. js/game.js:updateTraffic and js/entities.js:spawnTraffic,
-- ported whole, in metres and seconds.
--
-- PURE: nothing in this file touches an Instance, and it does not know whether
-- it is being run by a client or by a server. That is the same split the city
-- already uses -- VehicleModel is the physics and VehicleController is the
-- parts -- and it is what would let this move to the server later without a
-- rewrite. See ROBLOX_PORT_PLAN.md §7.3 for why it is not there today.
--
-- EVERY CAR IS THE PLAYER'S CAR WITH DIFFERENT NUMBERS IN IT. They run through
-- VehicleModel.step, the same integrator, with a lower accel and a lower top
-- speed -- so traffic slides, understeers and gets shunted the way the player's
-- car does, rather than being animated along a spline and pretending.
--
-- WHAT DRIVES THEM IS AN AIM POINT DOWN THE ROAD, not the next node. Steering
-- at the node itself puts a car into a loop: it cannot turn tightly enough at
-- speed, sails past, finds the node behind it, turns back and misses from the
-- other side. The point is walked LOOK metres along the polyline and
-- interpolated, so on a straight it is dead ahead and into a corner it rounds
-- the corner before the car does.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local VehicleModel = require(Shared:WaitForChild("VehicleModel"))
local Streets = require(Shared:WaitForChild("Streets"))

local Traffic = {}

-- ---------------------------------------------------------------- the fleet

-- EVERY TENTH VEHICLE IS SOMETHING OTHER THAN A CAR, counted rather than
-- rolled: ten cars is reliably one of these, and the five are taken in turn.
-- A random pick of five over the handful on screen at once will happily show
-- three ambulances and no bus, and the variety is the entire point.
--
-- The shape IS the vehicle -- the same box construction, made longer, wider and
-- taller -- with a real mass, because a twelve-tonne bus that shunts like a
-- hatchback is a worse lie than one that looks wrong, and a real top speed,
-- because these things do not keep up with traffic.
export type Kind = {
	livery: string,
	l: number,
	w: number,
	bh: number,
	mass: number,
	top: { number },
	col: Color3?,
	boxy: boolean, -- a van body: cabin nearly the whole length, not a bonnet
}

Traffic.EVERY = 10
Traffic.KINDS = {
	{ livery = "lorry", l = 8.2, w = 2.45, bh = 3.10, mass = 9, top = { 8, 12 }, col = nil, boxy = true },
	{ livery = "bus", l = 10.4, w = 2.55, bh = 3.15, mass = 11, top = { 8, 12 }, col = Color3.fromRGB(201, 150, 47), boxy = true },
	{ livery = "fire", l = 7.4, w = 2.50, bh = 2.70, mass = 8, top = { 9, 13 }, col = Color3.fromRGB(224, 48, 31), boxy = true },
	{ livery = "police", l = 4.7, w = 2.05, bh = 1.50, mass = 1.35, top = { 12, 17 }, col = Color3.fromRGB(238, 241, 246), boxy = false },
	{ livery = "ambulance", l = 6.0, w = 2.25, bh = 2.55, mass = 4, top = { 10, 15 }, col = Color3.fromRGB(244, 246, 250), boxy = true },
} :: { Kind }

-- PAL.carBody, js/util.js:181.
local BODY = {
	Color3.fromRGB(255, 79, 216),
	Color3.fromRGB(51, 230, 255),
	Color3.fromRGB(255, 227, 106),
	Color3.fromRGB(72, 255, 158),
	Color3.fromRGB(255, 112, 67),
	Color3.fromRGB(201, 162, 255),
	Color3.fromRGB(245, 245, 245),
	Color3.fromRGB(125, 227, 255),
	Color3.fromRGB(255, 95, 141),
	Color3.fromRGB(155, 225, 93),
}

export type Npc = {
	car: VehicleModel.Car,
	way: Streets.Way,
	idx: number, -- the node being driven towards
	dir: number, -- which way along the polyline: 1 or -1
	mass: number,
	bh: number,
	colour: Color3,
	livery: string?,
	boxy: boolean,
	gi: number, -- stable index, so a pair resolves once rather than twice
	model: Instance?, -- whatever the caller hung on it; this file never reads it
}

export type State = {
	cars: { Npc },
	seq: number, -- the every-tenth counter
	grid: { [number]: { Npc } },
	topUp: number,
	-- Cars culled by the last step, for the caller to take the parts off. This
	-- file makes no Instances and so cannot destroy any; handing back the list
	-- is how it stays pure without leaking a model every time somebody drives
	-- away from a bus.
	gone: { Npc },
}

-- ---------------------------------------------------------------- settings

-- The browser's daylight cap (TRAFFIC_N * 3) -- and daylight is what this port
-- runs in, ClockTime 15.
Traffic.CAP = 78

-- HOW FAR OUT TRAFFIC LIVES. The browser sizes this off its own viewport
-- because it is looking straight down; a chase camera nine metres behind the
-- car sees a good deal further down the street than a top-down view of the same
-- width, so this is a flat radius instead. Cars are culled beyond it and
-- spawned in the band just inside it, so nothing pops into existence in frame.
Traffic.KEEP = 260 -- metres: culled beyond this
Traffic.RING = 200 -- metres: new cars arrive between here and KEEP

-- PREFER A STREET WITH SOME ROAD IN IT when choosing where to put a car. The
-- browser asks for 140 m and that number does not survive the move: it was
-- tuned against Overpass ways as they arrive in the browser, and on this baked
-- district only 71 of 688 drivable ways are that long -- so it would put nearly
-- all the traffic on a tenth of the network and leave every side street empty.
--
-- 60 m is 249 of them, which favours through-roads without emptying the rest.
-- The filter also matters less than it did: it existed so a car would not spawn
-- on a stub and immediately turn round, and since junctions are followed
-- (see leaveWay) a short way is no longer a trap.
Traffic.MIN_WAY = 60

-- GAP_STOP is a car length and a half of hard brake; between there and GAP_SEE
-- it lifts off proportionally, so a queue settles into a rolling gap instead of
-- the brake/floor-it concertina that ends in a shunt.
local GAP_STOP, GAP_SEE = 7, 22

-- The bucket grid the neighbour tests run off. Without it the sweep is every
-- car against every other -- six thousand tests a frame at this cap.
local TCELL = 26

local function tkey(x: number, y: number): number
	return math.floor(x / TCELL) * 8192 + math.floor(y / TCELL)
end

-- ---------------------------------------------------------------- one car

local function rand(a: number, b: number): number
	return a + math.random() * (b - a)
end

local function makeNpc(x: number, y: number, h: number): Npc
	local c = VehicleModel.newCar(x, y, h)
	c.kind = "traffic"
	c.w = rand(1.85, 2.15)
	c.l = rand(4.1, 4.9)
	c.maxSpeed = rand(11, 17)
	c.accel = 7
	c.turn = 2.7
	return {
		car = c,
		way = Streets.ways[1],
		idx = 1,
		dir = 1,
		mass = 1,
		bh = rand(1.32, 1.58),
		colour = BODY[math.random(1, #BODY)],
		livery = nil,
		boxy = false,
		gi = 0,
		model = nil,
	}
end

-- Applied AFTER makeNpc rather than inside it, because it overwrites half of
-- what makeNpc just decided and reading it interleaved with the defaults would
-- hide which of the two won.
local function serviceVehicle(n: Npc, seq: number)
	local k = Traffic.KINDS[(seq // Traffic.EVERY) % #Traffic.KINDS + 1]
	n.livery = k.livery
	n.car.l = k.l
	n.car.w = k.w
	n.bh = k.bh
	n.mass = k.mass
	n.boxy = k.boxy
	n.car.maxSpeed = rand(k.top[1], k.top[2])
	if k.col then
		n.colour = k.col :: Color3
	end
end

-- ---------------------------------------------------------------- the state

function Traffic.new(): State
	return { cars = {}, seq = 0, grid = {}, topUp = 0, gone = {} }
end

local function gridAdd(state: State, n: Npc)
	local k = tkey(n.car.x, n.car.y)
	local a = state.grid[k]
	if a then
		table.insert(a, n)
	else
		state.grid[k] = { n }
	end
end

-- The cars in this cell and the eight around it, into a shared array the caller
-- reads and is done with.
local NEAR: { Npc } = {}
local function nearCars(state: State, x: number, y: number): { Npc }
	table.clear(NEAR)
	local gx, gy = math.floor(x / TCELL), math.floor(y / TCELL)
	for i = -1, 1 do
		for j = -1, 1 do
			local a = state.grid[(gx + i) * 8192 + gy + j]
			if a then
				table.move(a, 1, #a, #NEAR + 1, NEAR)
			end
		end
	end
	return NEAR
end

-- ---------------------------------------------------------------- spawning

-- `wide` fills the whole ring, for a standing start: opening a city with every
-- car in the outer band leaves the street you are actually parked on empty
-- until something happens to drive down it.
function Traffic.spawn(state: State, px: number, py: number, count: number, wide: boolean)
	local r1 = Traffic.KEEP - 4
	local r0 = if wide then 30 else Traffic.RING
	for _ = 1, count do
		local p = Streets.roadPoint(px, py, r0, r1, Traffic.MIN_WAY)
			or Streets.roadPoint(px, py, r0, r1)
			or Streets.roadPoint(px, py, 30, r1)
		if not p then
			continue
		end
		local spot = p :: Streets.Spot

		-- WHICH WAY ALONG, AND THEREFORE WHICH WAY IT FACES. Handing every car
		-- the segment's own heading regardless of the direction it was given
		-- spawns half the traffic pointing backwards down its own lane, and it
		-- spends its first seconds swinging round.
		local dir = if math.random() < 0.5 then 1 else -1
		local h = if dir > 0 then spot.h else spot.h + math.pi
		local off = Streets.laneOffset(spot.way)
		local sx = spot.x + math.cos(h + math.pi * 0.5) * off
		local sy = spot.y + math.sin(h + math.pi * 0.5) * off

		-- Not on top of one that is already there. roadPoint picks without
		-- looking, so two cars in the same tick can land on the same metre of
		-- tarmac -- which reads as one car with a shadow, then as a shunt.
		local taken = false
		for _, o in nearCars(state, sx, sy) do
			if (o.car.x - sx) ^ 2 + (o.car.y - sy) ^ 2 < 49 then
				taken = true
				break
			end
		end
		if taken then
			continue
		end

		local n = makeNpc(sx, sy, h)
		state.seq += 1
		if state.seq % Traffic.EVERY == 0 then
			serviceVehicle(n, state.seq)
		end
		n.way = spot.way
		n.idx = spot.idx
		n.dir = dir
		n.gi = #state.cars + 1
		table.insert(state.cars, n)
		-- into the grid straight away, or the next car in this same call cannot
		-- see it: the grid is rebuilt once a tick and a whole rush hour is
		-- spawned in one of them
		gridAdd(state, n)
	end
end

-- ---------------------------------------------------------------- the driving

local function angDiff(a: number, b: number): number
	return VehicleModel.angDiff(a, b)
end

local INPUT = { gas = 0, brake = 0, steer = 0, hand = 0 }

-- OFF THE END OF THE STREET AND ON TO THE NEXT ONE.
--
-- The browser has one answer here -- turn round and drive back -- and on this
-- data that is a U-turn every five seconds, because OSM cuts a street at every
-- junction and the mean way is 62 m long. Turning round on an eight metre
-- street puts a car through the pavement and into the building behind it, which
-- is exactly what the Node harness measured before this existed.
--
-- So a junction is taken if there is one, and turning round is what happens at
-- a genuine dead end -- which, on this district, is 8% of way ends: the stubs
-- and the streets cut off by the edge of the slice.
local function leaveWay(n: Npc, ranOff: number): boolean
	local w, node, dir = Streets.turning(n.way, ranOff, math.cos(n.car.h), math.sin(n.car.h))
	if not w then
		return false
	end
	n.way = w :: Streets.Way
	n.dir = dir :: number
	-- Aim at the node BEYOND the junction, not at the junction itself: the car
	-- is standing on the junction, and a target under the wheels is atan2 of
	-- nothing for a heading.
	n.idx = math.clamp((node :: number) + (dir :: number), 1, Streets.nodeCount(n.way))
	return true
end

local function driveOne(state: State, n: Npc, dt: number, pcar: VehicleModel.Car?)
	local t = n.car
	-- REASSIGNED, NOT CONSTANT: taking a junction below swaps the way out from
	-- under this, and everything after the advance loop -- the aim-point walk,
	-- the lane offset -- has to be reading the street the car is now on.
	local r = n.way
	local nodes = Streets.nodeCount(r)
	if nodes < 2 then
		return
	end
	n.idx = math.clamp(n.idx, 1, nodes)

	local spd = math.sqrt(t.vx * t.vx + t.vy * t.vy)
	local reach = 6 + spd * 0.35 -- a node counts as reached sooner at speed
	local fx, fy = math.cos(t.h), math.sin(t.h)

	for _ = 1, 8 do
		local nx, ny = Streets.node(r, n.idx)
		local dx0, dy0 = nx - t.x, ny - t.y
		local d2 = dx0 * dx0 + dy0 * dy0
		-- reached it, OR gone past it. Passing one used to leave the car turning
		-- round to come back for a node it had already driven over.
		local done = d2 < reach * reach or (dx0 * fx + dy0 * fy < 0 and d2 < 900)
		if not done then
			break
		end
		n.idx += n.dir
		if n.idx < 1 or n.idx > nodes then
			-- The end it ran off is the one it was heading for.
			local ranOff = if n.dir > 0 then nodes else 1
			if leaveWay(n, ranOff) then
				break
			end
			-- a real dead end: turn round, stepping back TWO so the car is not
			-- stood on its own target with atan2 of a zero vector for a heading
			n.dir = -n.dir
			n.idx = math.clamp(n.idx + 2 * n.dir, 1, nodes)
			break
		end
	end

	r = n.way
	nodes = Streets.nodeCount(r)
	if nodes < 2 then
		return
	end

	-- the point LOOK metres further along the way, wherever that falls
	local LOOK = 10 + spd * 0.6
	local ax, ay = Streets.node(r, n.idx)
	local left = LOOK - math.sqrt((ax - t.x) ^ 2 + (ay - t.y) ^ 2)
	local k = n.idx

	-- THE DIRECTION OF THE ROAD AT THE AIM POINT, tracked alongside it, because
	-- the lane offset below has to be square to the TARMAC and not to the car.
	-- Taking it from the car's own heading looks identical on a straight and is
	-- wrong in every corner: mid-bend the nose points across the lane, so an
	-- offset square to the car walks the aim point out of the road and the car
	-- chases it.
	local dux, duy = math.cos(t.h), math.sin(t.h)
	local function setDir(i: number, j: number)
		local iax, iay = Streets.node(r, i)
		local ibx, iby = Streets.node(r, j)
		local L = math.sqrt((ibx - iax) ^ 2 + (iby - iay) ^ 2)
		if L > 1e-6 then
			dux, duy = (ibx - iax) / L, (iby - iay) / L
		end
	end
	if n.idx + n.dir >= 1 and n.idx + n.dir <= nodes then
		setDir(n.idx, n.idx + n.dir)
	end
	while left > 0 do
		local nk = k + n.dir
		if nk < 1 or nk > nodes then
			break -- end of the way: aim at the end
		end
		local sax, say = Streets.node(r, k)
		local sbx, sby = Streets.node(r, nk)
		local seg = math.sqrt((sbx - sax) ^ 2 + (sby - say) ^ 2)
		if seg >= left then
			local u = left / seg
			ax, ay = sax + (sbx - sax) * u, say + (sby - say) * u
			setDir(k, nk)
			break
		end
		ax, ay = sbx, sby
		left -= seg
		k = nk
		setDir(k - n.dir, k)
	end

	-- And over into the right-hand lane. The AIM POINT carries the offset rather
	-- than the car being pushed sideways: the car then steers into its lane and
	-- holds it the way it holds anything else it follows, through junctions and
	-- round bends, with nothing for the physics to fight.
	local off = Streets.laneOffset(r)
	ax, ay = ax - duy * off, ay + dux * off

	local dx, dy = ax - t.x, ay - t.y
	if dx * dx + dy * dy < 1 then
		INPUT.gas, INPUT.brake, INPUT.steer = 0, 1, 0
		VehicleModel.step(t, INPUT, dt, nil, false)
		return
	end

	local want = math.atan2(dy, dx)
	local steer = math.clamp(angDiff(t.h, want) * 2.2, -1, 1)
	local throttle, brake = 1, 0

	-- slow down for whatever is directly in front
	local aheadX, aheadY = t.x + fx * 9, t.y + fy * 9
	if pcar then
		local p = pcar :: VehicleModel.Car
		if (aheadX - p.x) ^ 2 + (aheadY - p.y) ^ 2 < 42 then
			brake = 1
		end
	end

	-- AND FOR EACH OTHER. A car counts as "in the way" only if it is genuinely
	-- ahead and roughly in line: the dot product against our heading picks out
	-- in front from alongside, and the perpendicular offset picks out our lane
	-- from the oncoming one. Without this every car drives at a constant full
	-- throttle into whatever is in front of it and the city becomes a permanent
	-- demolition derby happening out of sight.
	local cs, sn = fx, fy
	local lead = math.huge
	for _, o in nearCars(state, t.x, t.y) do
		if o == n then
			continue
		end
		local rx, ry = o.car.x - t.x, o.car.y - t.y
		local fwd = rx * cs + ry * sn
		if fwd <= 0 or fwd > GAP_SEE then
			continue
		end
		if math.abs(-rx * sn + ry * cs) > 3.2 then
			continue -- the next lane, not ours
		end
		if fwd < lead then
			lead = fwd
		end
	end
	if lead < GAP_STOP then
		brake = 1
	elseif lead < GAP_SEE then
		throttle = math.max(0, (lead - GAP_STOP) / (GAP_SEE - GAP_STOP))
	end

	INPUT.gas = if brake > 0 then 0 else throttle
	INPUT.brake = brake
	INPUT.steer = steer
	VehicleModel.step(t, INPUT, dt, nil, false)
end

-- WHY onTarmac IS NIL ABOVE. VehicleModel's off-road crawl exists to stop the
-- player cutting across a park at 300 km/h. Traffic follows centrelines by
-- construction and never leaves them by choice, so the only thing the mask
-- would ever do to a traffic car is catch it mid-shunt and pin it there --
-- a car knocked half a metre off its lane crawling back at 16 km/h, blocking
-- the street behind it. They are on the road because of where they are steered,
-- which is a better guarantee than the mask is.

-- ---------------------------------------------------------------- collisions

-- Two oriented rectangles by the separating axis theorem -- four axes, the two
-- cars' own, which is exact for boxes. A circle test is wrong in both
-- directions at once here: side by side two cars are two metres apart and a
-- circle big enough to cover their length says they are touching, while nose to
-- tail the same circle does not fire until they have driven a metre and a half
-- into each other.
--
-- Returns the closing speed along the contact normal, having already separated
-- the pair and exchanged the impulse. Zero means no contact.
function Traffic.collide(
	ax: VehicleModel.Car,
	amass: number,
	bx: VehicleModel.Car,
	bmass: number
): number
	local dx, dy = bx.x - ax.x, bx.y - ax.y
	local d2 = dx * dx + dy * dy
	local reach = (math.sqrt(ax.l * ax.l + ax.w * ax.w) + math.sqrt(bx.l * bx.l + bx.w * bx.w)) * 0.5
	if d2 > reach * reach or d2 < 1e-6 then
		return 0
	end

	local ca, sa = math.cos(ax.h), math.sin(ax.h)
	local cb, sb = math.cos(bx.h), math.sin(bx.h)
	local al, aw = ax.l * 0.5, ax.w * 0.5
	local bl, bw = bx.l * 0.5, bx.w * 0.5
	local over, nx, ny = math.huge, 0, 0
	local axes = { ca, sa, -sa, ca, cb, sb, -sb, cb }
	for i = 1, 8, 2 do
		local ux, uy = axes[i], axes[i + 1]
		local ra = math.abs(ca * ux + sa * uy) * al + math.abs(-sa * ux + ca * uy) * aw
		local rb = math.abs(cb * ux + sb * uy) * bl + math.abs(-sb * ux + cb * uy) * bw
		local sep = dx * ux + dy * uy
		local o = ra + rb - math.abs(sep)
		if o <= 0 then
			return 0 -- a gap on this axis: no contact at all
		end
		if o < over then
			over = o
			local sgn = if sep < 0 then -1 else 1
			nx, ny = ux * sgn, uy * sgn
		end
	end

	local ia, ib = 1 / amass, 1 / bmass
	local inv = ia + ib
	-- the lighter car is moved further out of the overlap
	ax.x -= nx * over * (ia / inv)
	ax.y -= ny * over * (ia / inv)
	bx.x += nx * over * (ib / inv)
	bx.y += ny * over * (ib / inv)

	local rel = (ax.vx - bx.vx) * nx + (ax.vy - bx.vy) * ny
	if rel <= 0 then
		return 0
	end
	-- 1.56 keeps equal-mass impacts identical to the flat .78 this replaced
	local j = rel * 1.56 / inv
	ax.vx -= nx * j * ia
	ax.vy -= ny * j * ia
	bx.vx += nx * j * ib
	bx.vy += ny * j * ib
	return rel
end

-- The player against whatever is near them, off the same grid. Returns the
-- hardest impact of the tick, which is what a caller would put a sound and a
-- dent on. Separate from the pair sweep because the player is not in the list:
-- it is owned by VehicleController and only borrowed here.
function Traffic.hitPlayer(state: State, pcar: VehicleModel.Car, mass: number): number
	local worst = 0
	for _, o in nearCars(state, pcar.x, pcar.y) do
		local rel = Traffic.collide(pcar, mass, o.car, o.mass)
		if rel > worst then
			worst = rel
		end
	end
	return worst
end

-- ---------------------------------------------------------------- the tick

-- `pcar` is the player, or nil. `wallStop` is called for each car after its
-- step, with the car and where it was before that step, and is where the caller
-- resolves it against buildings -- this file has no opinion about how that is
-- done, and on the client it is a query against the server's collision folder.
function Traffic.step(
	state: State,
	dt: number,
	pcar: VehicleModel.Car?,
	px: number,
	py: number,
	wallStop: ((VehicleModel.Car, number, number) -> ())?
)
	-- ---- cull what has been left behind ----
	table.clear(state.gone)
	local keep2 = Traffic.KEEP * Traffic.KEEP
	local i = 1
	while i <= #state.cars do
		local n = state.cars[i]
		if (n.car.x - px) ^ 2 + (n.car.y - py) ^ 2 > keep2 then
			-- swap-remove: order in this list means nothing except to the pair
			-- ordering below, which is re-derived every tick anyway
			local last = #state.cars
			state.cars[i] = state.cars[last]
			state.cars[last] = nil
			-- the model is the caller's to dispose of; it is told by the return
			table.insert(state.gone, n)
		else
			i += 1
		end
	end

	-- ---- the grid, rebuilt once ----
	table.clear(state.grid)
	for k, n in state.cars do
		n.gi = k
		gridAdd(state, n)
	end

	-- ---- top up, rate-limited ----
	--
	-- Refilling is a search over the road index, so it does not run every frame.
	-- Traffic tops out at 17 m/s and the player does 100: outrun it and the list
	-- empties continuously, and topping up one a frame becomes sixty road
	-- searches a second for as long as a foot is down.
	state.topUp -= dt
	if state.topUp <= 0 then
		state.topUp = 0.25
		local need = Traffic.CAP - #state.cars
		if need > 0 then
			Traffic.spawn(state, px, py, math.min(if need > 40 then 25 else 5, need), false)
		end
	end

	-- ---- drive ----
	for _, n in state.cars do
		-- WHERE IT WAS, kept for the caller: the wedge case in a building
		-- resolve has no direction that frees the car, and the position before
		-- the step is the only one known to be clear.
		local wasX, wasY = n.car.x, n.car.y
		driveOne(state, n, dt, pcar)
		if wallStop then
			(wallStop :: (VehicleModel.Car, number, number) -> ())(n.car, wasX, wasY)
		end
	end

	-- ---- car on car, once per pair ----
	for _, n in state.cars do
		for _, o in nearCars(state, n.car.x, n.car.y) do
			if o.gi > n.gi then
				Traffic.collide(n.car, n.mass, o.car, o.mass)
			end
		end
	end
end

return Traffic
