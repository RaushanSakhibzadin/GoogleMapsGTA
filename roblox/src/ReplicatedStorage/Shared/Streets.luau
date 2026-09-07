--!strict
-- THE ROAD NETWORK AS SOMETHING YOU CAN FOLLOW, not as a picture of itself.
--
-- Tarmac wraps the baked road MASK and answers "is there tarmac under this
-- point", which is everything a car steered by a human needs to know. Nothing
-- steered by a human ever asks which way the street runs, so nothing in the
-- mask records it. A car steered by nothing needs exactly that, and so does a
-- pedestrian: js/game.js:updateTraffic walks a polyline looking for a point ten
-- metres further along it, and js/entities.js:pedWalkPoint takes the same
-- polyline and offsets it sideways to find the pavement.
--
-- So this wraps Shared/RoadNet, which is the centrelines themselves.
--
-- METRES, +x EAST, +y SOUTH -- the browser game's world, which is what
-- VehicleModel integrates in and what every constant in it was tuned against.
-- Studs happen once, when something is placed.
--
-- ONE-BASED, and worth stating because the source it was ported from is not.
-- A way's pts is flat -- x1, y1, x2, y2, ... -- so node n is at pts[n*2-1] and
-- pts[n*2], and segment n runs from node n to node n+1.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local RoadNet = require(Shared:WaitForChild("RoadNet"))
local SolidMask = require(Shared:WaitForChild("SolidMask"))
local Base64 = require(Shared:WaitForChild("Base64"))

export type Way = {
	w: number, -- carriageway width, metres
	len: number, -- total length of the polyline, metres
	oneway: boolean,
	pts: { number },
	i: number, -- its own index, stamped on below
}

export type Spot = {
	x: number,
	y: number,
	h: number, -- direction of the road here, radians, 0 = east
	way: Way,
	idx: number, -- the node the segment starts at
}

local Streets = {}

Streets.ways = RoadNet.ways :: { Way }

local CELL = RoadNet.cell
local BUCKETS = RoadNet.buckets
local LINKS = RoadNet.links

-- STAMPED ONCE, so a way knows its own index. Everything downstream holds a way
-- as a table -- it is what the aim-point walk reads a hundred times a second --
-- but the junction table is indexed by number, and a reverse lookup from table
-- to index on every turning would be either a scan or a second map to keep in
-- step. One field is cheaper than both.
for i, w in Streets.ways do
	w.i = i
end

function Streets.nodeCount(way: Way): number
	return #way.pts // 2
end

function Streets.node(way: Way, i: number): (number, number)
	return way.pts[i * 2 - 1], way.pts[i * 2]
end

-- ---------------------------------------------------------------- the buckets

-- REUSED, NOT ALLOCATED. This is called several times a second while the
-- traffic tops itself up, and it hands back the same two flat arrays every
-- time: the caller reads them and is done with them before anything else asks.
-- Pairs are stored flat -- way index, segment index, way index, ... -- because
-- a table of two-element tables here is a few thousand allocations a minute for
-- no gain.
local NEAR: { number } = {}

-- Every drivable segment whose cell touches the box of radius maxD about
-- (x, y). This is driveSegsNear in js/world.js, and it exists for the reason
-- given there: a random draw from the whole district misses the band nearly
-- every time once the district is bigger than the band.
function Streets.segsNear(x: number, y: number, maxD: number): { number }
	table.clear(NEAR)
	local gx0 = math.floor((x - maxD) / CELL)
	local gx1 = math.floor((x + maxD) / CELL)
	local gy0 = math.floor((y - maxD) / CELL)
	local gy1 = math.floor((y + maxD) / CELL)
	for gx = gx0, gx1 do
		for gy = gy0, gy1 do
			local arr = BUCKETS[gx * 8192 + gy]
			if arr then
				table.move(arr, 1, #arr, #NEAR + 1, NEAR)
			end
		end
	end
	return NEAR
end

-- ---------------------------------------------------------------- roadPoint

-- A random point on a drivable road in a band around somewhere, or nil.
--
-- js/world.js:roadPoint, including the 260-attempt budget: the band test is
-- done AFTER the draw rather than by building a filtered pool, because the pool
-- is the expensive part and a segment that reaches the cell usually reaches the
-- band. `minLen` skips short ways -- traffic spawned on a twelve metre stub
-- spends its whole life turning round at the end of it.
function Streets.roadPoint(
	fromX: number,
	fromY: number,
	minD: number?,
	maxD: number?,
	minLen: number?
): Spot?
	local pool: { number }? = nil
	if minD then
		pool = Streets.segsNear(fromX, fromY, maxD or 400)
		if #(pool :: { number }) == 0 then
			return nil
		end
	end

	for _ = 1, 260 do
		local way: Way, i: number
		if pool then
			local p = pool :: { number }
			local k = (math.random(1, #p // 2) - 1) * 2
			way = Streets.ways[p[k + 1]]
			i = p[k + 2]
		else
			way = Streets.ways[math.random(1, #Streets.ways)]
			i = math.random(1, math.max(1, Streets.nodeCount(way) - 1))
		end
		if not way then
			continue
		end
		if minLen and way.len < minLen then
			continue
		end

		local ax, ay = Streets.node(way, i)
		local bx, by = Streets.node(way, math.min(i + 1, Streets.nodeCount(way)))
		local t = math.random()
		local px, py = ax + (bx - ax) * t, ay + (by - ay) * t
		local h = math.atan2(by - ay, bx - ax)
		if not minD then
			return { x = px, y = py, h = h, way = way, idx = i }
		end
		local d = math.sqrt((px - fromX) ^ 2 + (py - fromY) ^ 2)
		if d >= (minD :: number) and d <= (maxD :: number) then
			return { x = px, y = py, h = h, way = way, idx = i }
		end
	end
	return nil
end

-- ---------------------------------------------------------------- junctions

-- WHERE A CAR GOES WHEN ITS STREET RUNS OUT.
--
-- OSM splits a street at every junction, so on this district a way is 62 m long
-- and has four nodes: without this, traffic reverses at every corner, and a
-- U-turn on an eight metre street goes through the pavement and into the
-- building behind it.
--
-- `hx, hy` is the direction the car is travelling. The turning is picked by how
-- nearly straight-on it is, with enough jitter that the same junction does not
-- always send everybody the same way -- most traffic goes straight, some turns,
-- and nothing doubles back unless there is genuinely nowhere else.
--
-- Returns the way to join, the node to aim at, and the direction along it, or
-- nil at a real dead end.
function Streets.turning(way: Way, endNode: number, hx: number, hy: number): (Way?, number?, number?)
	local perWay = LINKS[way.i]
	if not perWay then
		return nil
	end
	local out = perWay[endNode]
	if not out or #out == 0 then
		return nil
	end

	local bestW, bestN, bestD, bestScore = nil, 0, 0, -math.huge
	for k = 1, #out, 3 do
		local w = Streets.ways[out[k]]
		local node, dir = out[k + 1], out[k + 2]
		-- The direction of travel leaving that node, worked out here rather than
		-- baked: two more numbers on every one of 4,436 links is 90 kB of Luau,
		-- and a junction is taken about sixteen times a second across the whole
		-- fleet. Not a hot path, and not worth denormalising.
		local ax, ay = Streets.node(w, node)
		local bx, by = Streets.node(w, node + dir)
		local L = math.sqrt((bx - ax) ^ 2 + (by - ay) ^ 2)
		if L < 1e-6 then
			continue
		end
		local straight = ((bx - ax) / L) * hx + ((by - ay) / L) * hy
		if straight < -0.4 then
			continue -- that is a U-turn wearing a junction as a disguise
		end
		-- Enough jitter to break the tie between two similar turnings, not
		-- enough to send a car back down a side street past an open straight.
		local score = straight + math.random() * 0.5
		if score > bestScore then
			bestScore = score
			bestW, bestN, bestD = w, node, dir
		end
	end
	if not bestW then
		return nil
	end
	return bestW, bestN, bestD
end

-- ---------------------------------------------------------------- offsets

-- Which side of the centreline a car drives on. js/entities.js:568 -- a quarter
-- of the carriageway, clamped, so a wide boulevard puts oncoming traffic
-- properly apart and a back street does not put both lanes in the gutter.
function Streets.laneOffset(way: Way): number
	local w = if way.w > 0 then way.w else 8
	return math.clamp(w * 0.25, 1.2, 3.5)
end

-- And where the pavement is: just outside the kerb, so a boulevard's walkers
-- are further out than a back street's without anything having to know which is
-- which. PAVE_GAP = 1.5 in js/entities.js.
function Streets.pedOffset(way: Way): number
	local w = if way.w > 0 then way.w else 6
	return w * 0.5 + 1.5
end

-- Where the pavement is at node `idx` of `way`, on `side`, for someone walking
-- in `dir`. Returns x, y, and the unit direction of travel, or nil.
--
-- THE SEGMENT IS TAKEN BACKWARDS FROM THE TARGET where there is a node behind
-- it and forwards where there is not, and that is not a nicety: clamping the
-- index instead is wrong at exactly the two places every walker eventually
-- reaches. At either end of a way i - dir clamps back to i, the "segment" is a
-- point, and the fallback heading of due east puts the pavement five metres
-- east of the node -- which on a north-south street is the middle of the road.
function Streets.pedWalkPoint(
	way: Way,
	idx: number,
	dir: number,
	side: number
): (number?, number?, number?, number?)
	local n = Streets.nodeCount(way)
	if n < 2 then
		return nil
	end
	local i = math.clamp(idx, 1, n)
	local ax, ay = Streets.node(way, i)

	local j, flip = i - dir, 1
	if j < 1 or j > n then
		j = i + dir
		flip = -1
	end
	if j < 1 or j > n then
		return nil
	end
	local bx, by = Streets.node(way, j)
	local hx, hy = (ax - bx) * flip, (ay - by) * flip
	local L = math.sqrt(hx * hx + hy * hy)
	if L < 1e-6 then
		return nil
	end
	hx, hy = hx / L, hy / L
	local off = Streets.pedOffset(way)
	return ax - hy * off * side, ay + hx * off * side, hx, hy
end

-- ---------------------------------------------------------------- solid

-- IS THERE A BUILDING HERE. One bit a cell, baked by tools/roblox/7-life.mjs at
-- 3 m -- fine enough that a walker does not cross a wall, coarse enough to be
-- 20 kB. Outside the district reads as clear, which is right: there is nothing
-- out there to be inside of.
local SBITS = Base64.decode(SolidMask.bits)
local SSPAN = SolidMask.span
local SCELL = SolidMask.cellM
local SORIGIN = SolidMask.originM

function Streets.solidAt(x: number, y: number): boolean
	local i = math.floor((x - SORIGIN) / SCELL)
	local j = math.floor((y - SORIGIN) / SCELL)
	if i < 0 or i >= SSPAN or j < 0 or j >= SSPAN then
		return false
	end
	local at = j * SSPAN + i
	return (buffer.readu8(SBITS, at // 8) // (2 ^ (at % 8))) % 2 == 1
end

return Streets
