--!strict
-- BUILD THE CITY RIGHT NOW, from the Studio command bar:
--
--     require(game.ReplicatedStorage.CityVisual.BuildNow)()
--
-- and to clear it again:
--
--     require(game.ReplicatedStorage.CityVisual.BuildNow).clear()
--
-- WHY THIS EXISTS. The real builders are split the way the game needs them —
-- the shell on the client, the collision on the server — and neither runs until
-- you press Play. For looking at the city that is all friction: you cannot
-- orbit it, you cannot select a building to check its height, and every look
-- costs a play session.
--
-- This is the M0 tool. It runs in the EDIT session, builds both layers into
-- Workspace, and leaves them there to be flown around with the normal Studio
-- camera. It is not part of the game and nothing requires it at runtime.
--
-- The parts it makes are ordinary instances in your place. DO NOT SAVE the
-- place with them in it — call clear() first, or the next Rojo sync is fighting
-- forty thousand parts that should not be in the file. Nothing here is written
-- by Rojo, so clear() genuinely removes all of it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local Palette = require(CityVisual:WaitForChild("Palette")) :: { Color3 }
local Meta = require(CityVisual:WaitForChild("CityMeta"))
local ChunkData = CityVisual:WaitForChild("ChunkData")

local MS_PER_SLICE = 12 / 1000

-- WHETHER THE CITY CASTS SHADOWS AT ALL.
--
-- Off, and that is a real choice rather than a saving. Every shadow in the
-- first Studio builds was thrown by the INVISIBLE collision boxes -- transparency
-- hides a part but does not stop it casting -- so they were fitted to the
-- lattice rather than to the faces you can see, lined up with nothing, and
-- blinked as the camera moved. Reported as hard to look at, which it was.
--
-- With those silenced the honest options are no shadows, or shadows cast by the
-- shell itself. The shell is correct and aligned but it is tens of thousands of
-- casters, so it is worth measuring before it is assumed. Flip this to true to
-- try it; the sun angle still shades faces by their normal either way, so the
-- city is not flat with it off.
local CAST_SHADOWS = false

local M = {}

function M.clear()
	for _, name in { "City", "Collision", "Ground" } do
		local existing = workspace:FindFirstChild(name)
		if existing then
			existing:Destroy()
		end
	end
	-- Roblox's default Baseplate has its top face at y = 0, exactly coplanar
	-- with this city's ground layer, and z-fights with it across the whole
	-- 512-stud square around the origin. See the note in CityVisuals.
	local plate = workspace:FindFirstChild("Baseplate")
	if plate and plate:IsA("BasePart") then
		plate:Destroy()
	end
	print("[city] cleared")
end

local function shell(): number
	local template = Instance.new("Part")
	template.Anchored = true
	template.CanCollide = false
	template.CanQuery = false
	template.CanTouch = false
	template.CastShadow = CAST_SHADOWS
	template.Material = Enum.Material.SmoothPlastic
	template.TopSurface = Enum.SurfaceType.Smooth
	template.BottomSurface = Enum.SurfaceType.Smooth

	local root = Instance.new("Folder")
	root.Name = "City"
	root.Parent = workspace

	local made = 0
	local t0 = os.clock()

	for _, entry in Meta.chunks do
		local module = ChunkData:FindFirstChild(("Chunk_%d_%d"):format(entry[1], entry[2]))
		if not module then
			continue
		end
		local boxes = require(module) :: { number }
		local folder = Instance.new("Folder")
		folder.Name = module.Name

		local i = 1
		while i <= #boxes do
			local p = template:Clone()
			p.Size = Vector3.new(boxes[i + 3], boxes[i + 4], boxes[i + 5])
			p.Position = Vector3.new(boxes[i], boxes[i + 1], boxes[i + 2])
			p.Color = Palette[boxes[i + 6]]
			p.Parent = folder
			i += 7
			made += 1

			if made % 512 == 0 and os.clock() - t0 > MS_PER_SLICE then
				task.wait()
				t0 = os.clock()
			end
		end
		folder.Parent = root
	end
	return made
end

local function collision(): number
	local ServerScriptService = game:GetService("ServerScriptService")
	local data = ServerScriptService:FindFirstChild("Data")
	local mod = data and data:FindFirstChild("Collision")
	if not mod then
		warn("[city] no ServerScriptService.Data.Collision -- is Rojo connected?")
		return 0
	end

	local boxes = require(mod) :: { number }
	local template = Instance.new("Part")
	template.Anchored = true
	template.CanCollide = true
	-- Invisible: the voxel shell already occupies this space, and two visible
	-- surfaces in the same place is z-fighting. CastShadow off as well as
	-- transparent -- transparency hides a part, it does not stop it casting.
	template.Transparency = 1
	template.CastShadow = false

	local root = Instance.new("Folder")
	root.Name = "Collision"
	root.Parent = workspace

	local made = 0
	local t0 = os.clock()
	local i = 1
	while i <= #boxes do
		local p = template:Clone()
		p.Size = Vector3.new(boxes[i + 3], boxes[i + 4], boxes[i + 5])
		p.Position = Vector3.new(boxes[i], boxes[i + 1], boxes[i + 2])
		p.Parent = root
		i += 6
		made += 1

		if made % 512 == 0 and os.clock() - t0 > MS_PER_SLICE then
			task.wait()
			t0 = os.clock()
		end
	end
	return made
end

return setmetatable(M, {
	__call = function(_, withCollision: boolean?)
		M.clear()
		local started = os.clock()

		local parts = shell()
		local visual = os.clock()
		print(("[city] %d visual parts in %.2fs"):format(parts, visual - started))

		-- Off by default: the collision boxes are invisible, so for looking at
		-- the city they are forty thousand instances of nothing to see. Pass
		-- true when you want to test driving against them.
		local boxes = 0
		if withCollision then
			boxes = collision()
			print(("[city] %d collision boxes in %.2fs"):format(boxes, os.clock() - visual))
		end

		local ground = Instance.new("Part")
		ground.Name = "Ground"
		ground.Anchored = true
		ground.Transparency = 1
		ground.CastShadow = false
		ground.Size = Vector3.new(Meta.halfStuds * 2, 4, Meta.halfStuds * 2)
		ground.Position = Vector3.new(0, -2, 0)
		ground.Parent = workspace

		print(("[city] done in %.2fs -- %d parts total, %d studs across")
			:format(os.clock() - started, parts + boxes, Meta.halfStuds * 2))
		return parts + boxes
	end,
})
