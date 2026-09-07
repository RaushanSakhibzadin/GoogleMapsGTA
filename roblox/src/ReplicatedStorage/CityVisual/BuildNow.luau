--!strict
-- BUILD THE CITY RIGHT NOW, from the Studio command bar:
--
--     require(game.ReplicatedStorage.CityVisual.BuildNow)()
--
-- with collision as well, to drive against:
--
--     require(game.ReplicatedStorage.CityVisual.BuildNow)(true)
--
-- and to clear it again:
--
--     require(game.ReplicatedStorage.CityVisual.BuildNow).clear()
--
-- WHY THIS EXISTS. The real builders are split the way the game needs them --
-- the shell on the client, the collision on the server -- and neither runs
-- until you press Play. For looking at the city that is all friction: you
-- cannot orbit it, you cannot select a building to check its height, and every
-- look costs a play session.
--
-- This runs in the EDIT session and leaves the city in Workspace for the normal
-- Studio camera. It is not part of the game and nothing requires it at runtime.
--
-- The parts it makes are ordinary instances in your place. DO NOT SAVE the
-- place with them in it -- call clear() first, or the file grows by a hundred
-- thousand parts that should not be in it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local Meta = require(CityVisual:WaitForChild("CityMeta"))
local CityBuild = require(CityVisual:WaitForChild("CityBuild"))

local MS_PER_SLICE = 12 / 1000

local M = {}

function M.clear()
	CityBuild.clearWorkspace({ "City", "Collision", "Ground" })
	print("[city] cleared")
end

-- The collision boxes: invisible, and the only thing a car can hit. Square
-- whatever the visual lattice is -- nobody can see that what stopped them was a
-- box rather than a hexagon, and boxes merge in all three directions.
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
	template.Transparency = 1
	-- Transparency hides a part; it does not stop it casting.
	template.CastShadow = false

	local root = Instance.new("Folder")
	root.Name = "Collision"
	root.Parent = workspace

	local made, t0, i = 0, os.clock(), 1
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
	template:Destroy()
	return made
end

return setmetatable(M, {
	__call = function(_, withCollision: boolean?)
		M.clear()
		local started = os.clock()

		local parts, realHex = CityBuild.shell(false, MS_PER_SLICE, function()
			task.wait()
		end)
		local visual = os.clock()
		print(
			("[city] %d visual parts in %.2fs (%s)"):format(
				parts,
				visual - started,
				if CityBuild.isHex
					then (if realHex then "hex prisms" else "hex lattice, BLOCK fallback")
					else "boxes"
			)
		)

		-- Off by default: the collision boxes are invisible, so for looking at
		-- the city they are thousands of instances of nothing to see.
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

		print(
			("[city] done in %.2fs -- %d parts, %d studs across")
				:format(os.clock() - started, parts + boxes, Meta.halfStuds * 2)
		)
		return parts + boxes
	end,
})
