--!strict
-- BUILDINGS STOP THE CAR. Ported from buildingCollide() in js/entities.js.
--
-- THE CAR IS A BODY, NOT A POINT, and that is the whole of it. The browser game
-- tested one point at the car's centre for a long time, and the consequence was
-- that a gap narrower than the car was still a gap: you could thread a 4.5 m
-- car down a 1.2 m alley between two blocks, and so could the police. Eight
-- points spread over the body -- four corners, four edge midpoints -- is what
-- makes a wall a wall.
--
-- THE RE-TEST IS THE OTHER HALF. Pushing a point out of a building along the
-- nearest face is easy; the hard case is a car wedged in a gap where BOTH walls
-- push it out at once, and the resolved position is inside the other building.
-- An earlier version of the original used a heuristic about opposing normals
-- and it let a car worm 20 m down a 1.2 m gap. What works is checking: resolve,
-- test the resolved position, and if it is still buried fall back to where the
-- car was before this step -- the one place that is certainly clear.
--
-- WHY NOT ROBLOX'S PHYSICS. The car is kinematic: VehicleModel integrates its
-- position, and the feel comes from constants tuned against that integrator.
-- Handing it to constraints would mean re-deriving all of them. So the
-- collision volumes are queried through Roblox's broadphase and resolved by
-- hand, which is exactly what the browser does against its own bucket grid.
--
-- Everything here is in METRES, like the driving model. The parts it queries
-- are in studs, so the one conversion happens at the query boundary.
--
-- THE TEST IS 2D AND THE WORLD IS NOT. Resolving in the ground plane is right
-- for a car -- it cannot climb, so height never decides whether it fits -- but
-- it means a box's Y extent has to be dealt with BEFORE the test, not inside
-- it. A building with an archway carved through it is exactly that case: the
-- collision above the passage is a real box, and flattened into two dimensions
-- it becomes a wall standing on the road. Reported as "the car is stuck here,
-- cannot go through", under a visibly open arch.
--
-- So the broadphase query is a SLAB at the car's own height rather than a
-- column through the whole world, and anything whose underside is above the
-- roof simply never reaches the resolver.

local BuildingCollide = {}

-- Four corners and four edge midpoints, as fractions of half-length and
-- half-width. Corners alone let a wall pass through the middle of a long
-- flank; the midpoints are what stop that.
local BODY = {
	{ 0.5, 0.5 },
	{ 0.5, -0.5 },
	{ -0.5, 0.5 },
	{ -0.5, -0.5 },
	{ 0.5, 0 },
	{ -0.5, 0 },
	{ 0, 0.5 },
	{ 0, -0.5 },
}

-- A few centimetres of daylight, so a resolved car is not immediately inside
-- again on the next frame and jittering between the two states.
local SKIN = 0.06

-- How tall the car is, in metres, for the slab the broadphase asks about.
-- Matches CarBuild.HEIGHT; a little under would let the car clip a soffit it
-- should hit, and a lot over would put the archway's own ceiling back in the
-- way of the car driving under it.
BuildingCollide.CAR_H = 1.45

export type Box = { x: number, z: number, hx: number, hz: number }

-- How deep a point is inside an axis-aligned box, and which way is out.
-- Returns depth (0 if outside) plus the unit normal of the nearest face.
local function penetration(box: Box, px: number, pz: number): (number, number, number)
	local dx = px - box.x
	local dz = pz - box.z
	local ox = box.hx - math.abs(dx)
	local oz = box.hz - math.abs(dz)
	if ox <= 0 or oz <= 0 then
		return 0, 0, 0
	end
	-- Out through the nearest face, which is the smaller of the two overlaps.
	if ox < oz then
		return ox + SKIN, (if dx < 0 then -1 else 1), 0
	end
	return oz + SKIN, 0, (if dz < 0 then -1 else 1)
end

-- Is any of the car's body inside any of these boxes at this position?
local function buried(
	x: number,
	z: number,
	h: number,
	l: number,
	w: number,
	boxes: { Box }
): boolean
	local cs, sn = math.cos(h), math.sin(h)
	for _, p in BODY do
		local ox, oz = p[1] * l, p[2] * w
		local px = x + cs * ox - sn * oz
		local pz = z + sn * ox + cs * oz
		for _, b in boxes do
			local d = penetration(b, px, pz)
			if d > 0 then
				return true
			end
		end
	end
	return false
end

-- Resolve the car against the boxes near it.
--
-- `car` is a VehicleModel car (metres; x east, y south). `prev` is where it was
-- before this step, which is the fallback when there is nowhere else to go.
-- Returns the speed lost, which is what a damage model would read.
function BuildingCollide.resolve(
	car: { x: number, y: number, h: number, vx: number, vy: number, l: number, w: number },
	boxes: { Box },
	prevX: number,
	prevY: number
): number
	if #boxes == 0 then
		return 0
	end

	local cs, sn = math.cos(car.h), math.sin(car.h)
	local deepest, nx, nz = 0, 0, 0

	for _, p in BODY do
		local ox, oz = p[1] * car.l, p[2] * car.w
		local px = car.x + cs * ox - sn * oz
		local pz = car.y + sn * ox + cs * oz
		for _, b in boxes do
			local d, ax, az = penetration(b, px, pz)
			if d > deepest then
				deepest, nx, nz = d, ax, az
			end
		end
	end

	if deepest <= 0 then
		return 0
	end

	local hit = math.sqrt(car.vx * car.vx + car.vy * car.vy)
	local rx = car.x + nx * deepest
	local ry = car.y + nz * deepest

	-- THE WEDGE CASE. If pushing out of the deepest wall lands us inside
	-- another one, there is no direction that frees the car this step. Where it
	-- was is the only position known to be clear.
	if buried(rx, ry, car.h, car.l, car.w, boxes) then
		if not buried(prevX, prevY, car.h, car.l, car.w, boxes) then
			car.x, car.y = prevX, prevY
		else
			car.x, car.y = rx, ry
		end
		car.vx, car.vy = 0, 0
		return hit
	end

	car.x, car.y = rx, ry

	-- Kill the component of velocity going INTO the wall and keep the rest, so
	-- a glancing blow slides along the face instead of stopping dead. The 1.5
	-- is the original's: a little more than cancelling, which reads as the car
	-- being pushed off rather than sticking.
	local into = -(car.vx * nx + car.vy * nz)
	if into > 0 then
		car.vx += nx * into * 1.5
		car.vy += nz * into * 1.5
		return into
	end
	return 0
end

-- Gather the collision boxes near a point, converted to metres.
--
-- Queried through Roblox's own broadphase rather than a hash of our own: the
-- boxes are already in Workspace as anchored parts, they are the only things in
-- that folder, and GetPartBoundsInBox is a good deal faster than anything this
-- file would do by hand.
--
-- All the collision volumes are axis-aligned, which is why a box is four
-- numbers here rather than a CFrame -- see the note in tools/roblox/5-emit.mjs
-- about collision staying square whatever the visual lattice is.
function BuildingCollide.near(
	x: number,
	y: number,
	radius: number,
	studsPerMetre: number,
	params: OverlapParams,
	out: { Box }
): { Box }
	table.clear(out)
	local S = studsPerMetre
	local r = radius * S

	-- A SLAB AT THE CAR'S HEIGHT, not a column through the world. This is what
	-- lets a car drive under an archway: the collision above the passage is a
	-- box like any other, and a query that reached from the ground to the sky
	-- would return it and the 2D resolver would treat it as a wall.
	local h = BuildingCollide.CAR_H * S
	local hits = workspace:GetPartBoundsInBox(
		CFrame.new(x * S, h * 0.5, y * S),
		Vector3.new(r * 2, h, r * 2),
		params
	)
	for _, part in hits do
		out[#out + 1] = {
			x = part.Position.X / S,
			z = part.Position.Z / S,
			hx = part.Size.X / (2 * S),
			hz = part.Size.Z / (2 * S),
		}
	end
	return out
end

return BuildingCollide
