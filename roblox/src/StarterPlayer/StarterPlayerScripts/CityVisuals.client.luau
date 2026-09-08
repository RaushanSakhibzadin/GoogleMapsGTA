--!strict
-- Build the city on the client, from the baked data -- and only the part of it
-- you are standing in.
--
-- ON THE CLIENT, AND ON PURPOSE. Every part this makes is decoration: the
-- collision the car actually hits is a separate, much smaller set built by the
-- server. So none of it replicates, none of it costs the server anything, and
-- none of it enters a physics broadphase.
--
-- ORDINARY PARTS, NOTHING GENERATED. Buildings are boxes and wedges, streets
-- are boxes, trees are a cylinder and an ellipsoid, and the only textures are
-- Roblox's own materials. An earlier build made a MeshPart per building through
-- EditableMesh -- the right shape for the job, and untestable from where this
-- was written; it failed twice for reasons that were invisible until somebody
-- looked at a screen. See CityParts.
--
-- ---------------------------------------------------------------------------
--
-- STREAMED, AND THAT IS NEW. It used to build the whole district on join, which
-- was affordable at 1.2 km and is not at 2.4:
--
--     buildings   179,401 parts   (38,484 walls + 52,936 roof + 87,981 glass)
--     streets      16,510
--     parks         4,308
--     trees        16,372
--     ----------------------
--     TOTAL       216,591 parts
--
-- Workspace.StreamingEnabled does NOT help here, and that is worth stating
-- because it looks like it should: Roblox streams what the SERVER replicates,
-- and every part in this file is made by a LocalScript. It never enters the
-- replication system, so it is never streamed out of it. The collision boxes
-- are server-built and do stream -- which is why the radius below is the same
-- 1,500 studs as StreamingTargetRadius, so what you can see and what you can
-- hit arrive together.
--
-- So the streaming is ours. The bake already chunks everything on a 128 m grid;
-- this loads the chunks near the player, nearest first, on a frame budget, and
-- drops them again once they are well behind. About 48 of 373 chunks are live
-- at any time -- roughly 28,000 parts instead of 216,591, and flat in the size
-- of the district rather than growing with it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local CityParts = require(CityVisual:WaitForChild("CityParts"))
local FlatMeta = require(CityVisual:WaitForChild("FlatMeta"))
local StreetMeta = require(CityVisual:WaitForChild("StreetMeta"))
local TreeMeta = require(CityVisual:WaitForChild("TreeMeta"))
local PlayerCar = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("PlayerCar"))

-- WAITED FOR, NOT INDEXED. `CityVisual.FlatData` throws "not a valid member" if
-- the folder has not replicated yet, and an error here kills the whole script
-- -- which renders as an entirely empty world while the minimap, being its own
-- script, carries on working. That is exactly how it presented once already.
local FlatData = CityVisual:WaitForChild("FlatData")

-- ---------------------------------------------------------------- settings

local CHUNK = FlatMeta.chunkStuds

-- MATCHED TO StreamingTargetRadius (1,500 studs = 500 m at 3 studs/m), so the
-- buildings you can see and the collision boxes you can hit arrive at the same
-- distance. Dropping is further out than loading on purpose: without the gap, a
-- chunk on the boundary is built and destroyed and built again every time the
-- car drifts a stud, which is the worst possible thing to do sixty times a
-- second.
local LOAD = 1500
local DROP = 1900

-- Milliseconds of building per frame. Six is what the whole-district build used
-- and it never hitched visibly; the difference now is that it is spent
-- continuously rather than all at once on join.
local MS_PER_FRAME = 6 / 1000

-- How often the wanted set is recomputed. Four times a second is far more often
-- than a chunk boundary can be crossed at any speed the car reaches -- 100 m/s
-- covers 25 m in a tick and a chunk is 128 m.
local RESCAN = 0.25

-- ---------------------------------------------------------------- the world

-- ROBLOX'S DEFAULT BASEPLATE IS 512 x 512 AT (0, -10, 0), so its top face sits
-- at y = 0 -- coplanar with this city's ground, and the two z-fight. It cost
-- three rounds of being chased as a shadow bug.
for _, name in { "City", "Baseplate" } do
	local stale = workspace:FindFirstChild(name)
	if stale then
		stale:Destroy()
	end
end

local root = Instance.new("Folder")
root.Name = "City"
root.Parent = workspace

-- The ground is ONE part for the whole district and is never streamed. At 2.4 km
-- it is a single 7,200 stud slab, which costs one part and saves the horizon
-- from being a hole where the next chunk has not arrived yet.
CityParts.ground(FlatMeta.halfStuds, StreetMeta.colours.plain, root)

-- ---------------------------------------------------------------- the index

-- Every chunk that has anything in it, from all three indexes, keyed by
-- position. A chunk usually has buildings, streets and trees, but the edges of
-- the district have plenty that only have one or two.
type Chunk = { cx: number, cz: number, x: number, z: number, d2: number }
local chunks: { [string]: Chunk } = {}
local order: { Chunk } = {}

local function note(cx: number, cz: number)
	local key = cx .. "," .. cz
	if chunks[key] then
		return
	end
	-- The centre of the chunk, which is what distance is measured to. A chunk is
	-- 384 studs across, so its corners reach 271 beyond its centre -- the load
	-- radius carries that slack rather than this doing four corner tests.
	local c: Chunk = {
		cx = cx,
		cz = cz,
		x = (cx + 0.5) * CHUNK,
		z = (cz + 0.5) * CHUNK,
		d2 = 0, -- filled in by each rescan, and only used to sort that rescan
	}
	chunks[key] = c
	table.insert(order, c)
end

for _, e in FlatMeta.chunks do
	note(e[1], e[2])
end
for _, e in StreetMeta.chunks do
	note(e[1], e[2])
end
for _, e in TreeMeta.chunks do
	note(e[1], e[2])
end

local SLACK = CHUNK * 0.71 -- half a chunk diagonal
local LOAD2 = (LOAD + SLACK) ^ 2
local DROP2 = (DROP + SLACK) ^ 2

-- ---------------------------------------------------------------- building

local live: { [string]: Folder } = {}
local pending: { Chunk } = {}
local head = 1 -- an index, not table.remove(t, 1), which is O(n) each time

local built = { buildings = 0, parts = 0, streets = 0, trees = 0 }

local budgetT = os.clock()
local ticks = 0
local function breathe()
	ticks += 1
	if ticks % 200 == 0 and os.clock() - budgetT > MS_PER_FRAME then
		RunService.Heartbeat:Wait()
		budgetT = os.clock()
	end
end

local function buildChunk(c: Chunk)
	local key = c.cx .. "," .. c.cz
	if live[key] then
		return
	end
	local folder = Instance.new("Folder")
	folder.Name = "Chunk_" .. key

	local street = FlatData:FindFirstChild(("Street_%d_%d"):format(c.cx, c.cz))
	if street then
		built.streets += CityParts.streets(require(street) :: any, StreetMeta, folder)
		breathe()
	end

	local flat = FlatData:FindFirstChild(("Flat_%d_%d"):format(c.cx, c.cz))
	if flat then
		for _, b in require(flat) :: { any } do
			built.parts += CityParts.building(b, FlatMeta, folder)
			built.buildings += 1
			breathe()
		end
	end

	local trees = FlatData:FindFirstChild(("Tree_%d_%d"):format(c.cx, c.cz))
	if trees then
		built.trees += CityParts.trees(
			{ colours = TreeMeta.colours, trees = require(trees) :: any },
			folder,
			breathe
		)
	end

	-- PARENTED LAST, so a chunk appears complete rather than growing a wall at a
	-- time in front of you. Every part above is made under a folder that is not
	-- in the world yet, which costs nothing and is the whole trick.
	folder.Parent = root
	live[key] = folder
end

-- ---------------------------------------------------------------- the loop

local function playerXZ(): (number, number)
	local car = PlayerCar.get()
	if car then
		-- The car is in metres; everything here is in studs.
		return car.x * FlatMeta.studsPerMetre, car.y * FlatMeta.studsPerMetre
	end
	-- Before the car exists, build out from the middle -- which is where it will
	-- appear, and means the first chunks are ready when it does.
	return 0, 0
end

local firstRingDone = false

local function rescan()
	local px, pz = playerXZ()

	-- How many chunks are in range and how many of those are not up yet. Counted
	-- before the queue is rebuilt, because the queue is what is MISSING and the
	-- loading bar wants the ratio.
	local wanted, missing = 0, 0
	for _, c in order do
		if (c.x - px) ^ 2 + (c.z - pz) ^ 2 <= LOAD2 then
			wanted += 1
			if not live[c.cx .. "," .. c.cz] then
				missing += 1
			end
		end
	end

	-- Drop what is well behind. Done first, so the parts a chunk is about to
	-- make are not competing with parts that should already be gone.
	for key, folder in live do
		local c = chunks[key]
		if c and (c.x - px) ^ 2 + (c.z - pz) ^ 2 > DROP2 then
			folder:Destroy()
			live[key] = nil
		end
	end

	-- Then gather what is missing, NEAREST FIRST: the street you are on should
	-- arrive before the one three blocks away, and on a join from cold that is
	-- the difference between driving immediately and waiting.
	table.clear(pending)
	head = 1
	-- WHAT THE LOADING SCREEN IS WATCHING. Reported as "the car does not exist
	-- at the beginning": three things have to land before the game is playable
	-- and this is one of them, so it says how far along it is rather than
	-- leaving ReplicatedFirst/Loading to guess. Only the FIRST ring is
	-- interesting -- after that the numbers keep moving as you drive and nobody
	-- is looking at them.
	if not firstRingDone then
		workspace:SetAttribute("CityRingWanted", math.max(1, wanted))
		workspace:SetAttribute("CityRingBuilt", wanted - missing)
	end
	for _, c in order do
		if not live[c.cx .. "," .. c.cz] then
			local d2 = (c.x - px) ^ 2 + (c.z - pz) ^ 2
			if d2 <= LOAD2 then
				c.d2 = d2
				table.insert(pending, c)
			end
		end
	end
	table.sort(pending, function(a: Chunk, b: Chunk): boolean
		return a.d2 < b.d2
	end)
end

local started = os.clock()
local reported = false

task.spawn(function()
	while true do
		rescan()
		while head <= #pending do
			local c = pending[head]
			head += 1
			-- Still wanted? The rescan that queued it may be several frames old
			-- by now and the car does 100 m/s.
			if not live[c.cx .. "," .. c.cz] then
				buildChunk(c)
			end
			if os.clock() - budgetT > MS_PER_FRAME then
				RunService.Heartbeat:Wait()
				budgetT = os.clock()
			end
		end

		if not reported then
			reported = true
			firstRingDone = true
			workspace:SetAttribute("CityRingBuilt", workspace:GetAttribute("CityRingWanted"))
			local ring = 0
			for _ in live do
				ring += 1
			end
			print(
				("[city] first ring: %d chunks, %d buildings, %d parts + %d street + %d tree in %.2fs")
					:format(ring, built.buildings, built.parts, built.streets, built.trees, os.clock() - started)
			)
			print(
				("[city] district %d chunks total, %d studs across -- streaming at %d studs")
					:format(#order, FlatMeta.halfStuds * 2, LOAD)
			)
		end

		task.wait(RESCAN)
	end
end)
