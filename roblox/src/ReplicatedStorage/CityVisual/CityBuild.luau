--!strict
-- Turn the baked chunk data into parts. One implementation, two callers.
--
-- The runtime builder (StarterPlayerScripts/CityVisuals) and the edit-mode one
-- (CityVisual/BuildNow) were near-identical copies, and every fix to the
-- shadow, baseplate and idempotence bugs had to be made twice. This is the
-- shared body; the callers differ only in when they run and how much of a frame
-- they may spend.
--
-- IT HANDLES BOTH LATTICES. Square chunks carry seven numbers a part -- centre
-- and size -- and hexagonal ones carry five, because a prism's footprint is
-- always the same hexagon and only its height varies. CityMeta says which.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local Palette = require(CityVisual:WaitForChild("Palette")) :: { Color3 }
local Meta = require(CityVisual:WaitForChild("CityMeta"))
local HexPrism = require(CityVisual:WaitForChild("HexPrism"))
-- TIMED, AND LOUD WHEN IT IS NOT THERE. The voxel chunks are only baked when
-- CONFIG.render is 'voxel' -- they are 29 MB of generated data on the 2.4 km
-- district for a renderer §5.4 measured at 83x the cost of the one in use -- so
-- an untimed WaitForChild here would simply hang forever with no message, which
-- is the worst way for a switched-off feature to present.
local ChunkData = CityVisual:WaitForChild("ChunkData", 5)
if not ChunkData then
	error(
		"[CityBuild] no ChunkData: the voxel city is not baked. "
			.. "Set CONFIG.render = 'voxel' in tools/roblox/config.mjs and re-run "
			.. "node tools/roblox/bake.mjs. The flat renderer (CityVisuals) needs none of this."
	)
end

local CityBuild = {}

CityBuild.isHex = Meta.lattice == "hex"

-- ROBLOX'S DEFAULT BASEPLATE IS 512 x 512 AT (0, -10, 0), so its top face sits
-- at y = 0 -- exactly coplanar with this city's ground layer, whose top face is
-- also at y = 0 so buildings stand on it rather than in it. Two visible
-- surfaces at identical depth is z-fighting: which one wins flips with
-- sub-pixel camera movement, so the ground churns every frame while the
-- buildings stay rock solid. It cost three rounds of being chased as a shadow
-- bug. It is not one; nothing in this city casts a shadow.
function CityBuild.clearWorkspace(names: { string })
	for _, name in names do
		local existing = workspace:FindFirstChild(name)
		if existing then
			existing:Destroy()
		end
	end
	local plate = workspace:FindFirstChild("Baseplate")
	if plate and plate:IsA("BasePart") then
		plate:Destroy()
	end
end

-- Build the whole visual shell under a fresh "City" folder.
--
-- `castShadows` is off by default everywhere and that is a real choice rather
-- than a saving: with the invisible collision boxes silenced, the honest
-- options are no shadows or shadows cast by the shell itself, and the shell is
-- tens of thousands of casters. The sun angle still shades faces by their
-- normal, so the city is not flat with it off.
--
-- `budget` is how many seconds of each slice this may spend before yielding.
-- Thirty thousand parts in one go is a freeze with no way to tell whether the
-- game has hung.
function CityBuild.shell(castShadows: boolean, budget: number, yieldFn: () -> ()): (number, boolean)
	local template, realHex = HexPrism.template()
	local hex = CityBuild.isHex

	local proto: BasePart
	if hex then
		proto = template:Clone()
	else
		local p = Instance.new("Part")
		p.Anchored = true
		p.CanCollide = false
		p.CanQuery = false
		p.CanTouch = false
		p.Material = Enum.Material.SmoothPlastic
		p.TopSurface = Enum.SurfaceType.Smooth
		p.BottomSurface = Enum.SurfaceType.Smooth
		proto = p
	end
	proto.CastShadow = castShadows

	local R = (Meta :: any).hexRadiusStuds or 0
	local root = Instance.new("Folder")
	root.Name = "City"
	root.Parent = workspace

	local stride = if hex then 5 else 7
	local made = 0
	local t0 = os.clock()

	for _, entry in Meta.chunks do
		local module = ChunkData:FindFirstChild(("Chunk_%d_%d"):format(entry[1], entry[2]))
		if not module then
			continue
		end
		local data = require(module) :: { number }
		local folder = Instance.new("Folder")
		folder.Name = module.Name

		local i = 1
		while i <= #data do
			local p = proto:Clone()
			if hex then
				-- x, y, z, height, colour
				p.Size = if realHex
					then HexPrism.size(R, data[i + 3])
					else HexPrism.blockSize(R, data[i + 3])
				p.Position = Vector3.new(data[i], data[i + 1], data[i + 2])
				p.Color = Palette[data[i + 4]]
			else
				-- x, y, z, sx, sy, sz, colour
				p.Size = Vector3.new(data[i + 3], data[i + 4], data[i + 5])
				p.Position = Vector3.new(data[i], data[i + 1], data[i + 2])
				p.Color = Palette[data[i + 6]]
			end
			p.Parent = folder
			i += stride
			made += 1

			-- Check the clock every 512 parts rather than every part: os.clock()
			-- is cheap but not free, and at this call count it showed up.
			if made % 512 == 0 and os.clock() - t0 > budget then
				yieldFn()
				t0 = os.clock()
			end
		end
		folder.Parent = root
	end

	proto:Destroy()
	return made, realHex
end

return CityBuild
