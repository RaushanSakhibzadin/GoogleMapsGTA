--!strict
-- Build the voxel city out of the baked chunk data.
--
-- ON THE CLIENT, AND ON PURPOSE. Every part this makes is decoration: the
-- collision the car actually hits is a separate, much smaller set built by the
-- server (ServerScriptService/BuildCity). So none of this replicates, none of
-- it costs the server anything, and none of it enters a physics broadphase —
-- which is what makes tens of thousands of parts affordable at all.
--
-- SPREAD ACROSS FRAMES. Thirty-odd thousand parts in one go is a freeze of
-- several seconds with no way to tell whether the game has hung. The loop below
-- yields whenever it has used its slice of a frame, so the city appears over a
-- second or two while everything else stays responsive.
--
-- CLONED, NOT CONSTRUCTED. Instance.new plus eight property assignments is
-- markedly slower than cloning a template that already has seven of them set.
-- At this part count that is the difference between a couple of seconds and a
-- good deal more.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local Palette = require(CityVisual:WaitForChild("Palette")) :: { Color3 }
local Meta = require(CityVisual:WaitForChild("CityMeta"))
local ChunkData = CityVisual:WaitForChild("ChunkData")

local MS_PER_FRAME = 6 / 1000 -- how much of each frame this may spend building

-- The template every voxel box is cloned from. CanCollide, CanQuery and
-- CanTouch are all off: this is scenery, and leaving any of them on would put
-- thirty thousand parts into the broadphase and raycast set for nothing.
local template = Instance.new("Part")
template.Anchored = true
template.CanCollide = false
template.CanQuery = false
template.CanTouch = false
template.CastShadow = false
template.Material = Enum.Material.SmoothPlastic
template.TopSurface = Enum.SurfaceType.Smooth
template.BottomSurface = Enum.SurfaceType.Smooth

local root = Instance.new("Folder")
root.Name = "City"
root.Parent = workspace

local function buildChunk(cx: number, cz: number, budget: number): number
	local module = ChunkData:FindFirstChild(("Chunk_%d_%d"):format(cx, cz))
	if not module then
		return budget
	end

	local boxes = require(module) :: { number }
	local folder = Instance.new("Folder")
	folder.Name = ("Chunk_%d_%d"):format(cx, cz)

	local t0 = os.clock()
	local i = 1
	while i <= #boxes do
		local p = template:Clone()
		p.Size = Vector3.new(boxes[i + 3], boxes[i + 4], boxes[i + 5])
		p.Position = Vector3.new(boxes[i], boxes[i + 1], boxes[i + 2])
		p.Color = Palette[boxes[i + 6]]
		p.Parent = folder
		i += 7

		-- Check the clock every 64 parts rather than every part: os.clock() is
		-- cheap but not free, and at this call count it showed up.
		if (i // 7) % 64 == 0 and os.clock() - t0 > budget then
			RunService.Heartbeat:Wait()
			t0 = os.clock()
			budget = MS_PER_FRAME
		end
	end

	folder.Parent = root
	return budget
end

local started = os.clock()
local total = 0

for _, entry in Meta.chunks do
	local cx, cz, n = entry[1], entry[2], entry[3]
	buildChunk(cx, cz, MS_PER_FRAME)
	total += n
end

print(("[city] %d parts across %d chunks in %.2fs"):format(total, #Meta.chunks, os.clock() - started))
