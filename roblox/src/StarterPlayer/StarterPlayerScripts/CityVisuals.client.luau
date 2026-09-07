--!strict
-- Build the city on the client, from the baked data.
--
-- ON THE CLIENT, AND ON PURPOSE. Every part this makes is decoration: the
-- collision the car actually hits is a separate, much smaller set built by the
-- server. So none of it replicates, none of it costs the server anything, and
-- none of it enters a physics broadphase.
--
-- ORDINARY PARTS, NOTHING GENERATED. Buildings are boxes and wedges, streets
-- are boxes, and the only textures are Roblox's own materials. An earlier build
-- made a MeshPart per building through EditableMesh -- the right shape for the
-- job, and untestable from where this was written; it failed twice for reasons
-- that were invisible until somebody looked at a screen. See CityParts.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local CityParts = require(CityVisual:WaitForChild("CityParts"))
local FlatMeta = require(CityVisual:WaitForChild("FlatMeta"))
local StreetMeta = require(CityVisual:WaitForChild("StreetMeta"))

-- WAITED FOR, NOT INDEXED. `CityVisual.FlatData` throws "not a valid member" if
-- the folder has not replicated yet, and an error here kills the whole script
-- -- which renders as an entirely empty world while the minimap, being its own
-- script, carries on working. That is exactly how it presented once already.
local FlatData = CityVisual:WaitForChild("FlatData")

local MS_PER_FRAME = 6 / 1000

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

local started = os.clock()
local t0 = os.clock()
local n = 0

local function breathe()
	n += 1
	if n % 200 == 0 and os.clock() - t0 > MS_PER_FRAME then
		RunService.Heartbeat:Wait()
		t0 = os.clock()
	end
end

CityParts.ground(FlatMeta.halfStuds, StreetMeta.colours.plain, root)

-- Streets first: they are what tells you where you can drive, and they come
-- from the same centrelines the drivable mask was stamped from.
local streets = 0
for _, entry in StreetMeta.chunks do
	local module = FlatData:FindFirstChild(("Street_%d_%d"):format(entry[1], entry[2]))
	if module then
		local folder = Instance.new("Folder")
		folder.Name = module.Name
		streets += CityParts.streets(require(module), StreetMeta, folder)
		folder.Parent = root
		breathe()
	end
end

local made, buildings = 0, 0
for _, entry in FlatMeta.chunks do
	local module = FlatData:FindFirstChild(("Flat_%d_%d"):format(entry[1], entry[2]))
	if not module then
		continue
	end
	local folder = Instance.new("Folder")
	folder.Name = module.Name
	for _, b in require(module) :: { any } do
		made += CityParts.building(b, FlatMeta, folder)
		buildings += 1
		breathe()
	end
	folder.Parent = root
end

print(
	("[city] %d buildings, %d parts, %d street parts in %.2fs")
		:format(buildings, made, streets, os.clock() - started)
)
