--!strict
-- Build the geometry the physics engine actually sees.
--
-- This is the whole of the city as far as a car is concerned: a few thousand
-- anchored boxes fitted to the same lattice the voxel shell is drawn on, so
-- what you can see is what you can hit. The shell itself is built by the
-- client (StarterPlayerScripts/CityVisuals) and collides with nothing.
--
-- These are the ONLY parts in the game with CanCollide true.

local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")

local Collision = require(ServerScriptService:WaitForChild("Data"):WaitForChild("Collision")) :: { number }

local MS_PER_FRAME = 8 / 1000

local template = Instance.new("Part")
template.Anchored = true
template.CanCollide = true
template.Material = Enum.Material.SmoothPlastic
-- INVISIBLE, because the voxel shell is standing in exactly this space. Two
-- visible surfaces in the same place is z-fighting, and the shell is the one
-- with the colours on it.
template.Transparency = 1
-- AND INVISIBLE IS NOT ENOUGH. Transparency hides a part; it does not stop it
-- casting. CastShadow defaults to true, so these boxes were throwing every
-- shadow in the city while the shell that you can actually see threw none --
-- and because they are fitted to the lattice rather than to the shell's own
-- faces, the shadows did not line up with anything and blinked as the camera
-- moved. Reported from Studio as "shadows still glitch/blink".
template.CastShadow = false

-- THE BASEPLATE GOES FIRST.
--
-- Roblox's default Baseplate is 512 x 512 studs at (0, -10, 0), so its TOP FACE
-- SITS AT y = 0 -- exactly coplanar with this city's ground layer, which also
-- has its top face at y = 0 so that buildings stand on it rather than in it.
-- Two visible surfaces at identical depth is z-fighting: which one wins flips
-- with sub-pixel camera movement, so the ground around the origin churns
-- between grey and asphalt every frame while the buildings stay rock solid.
--
-- It cost three rounds of chasing this as a shadow bug. It is not a shadow bug;
-- nothing in this city casts a shadow at all.
local plate = workspace:FindFirstChild("Baseplate")
if plate and plate:IsA("BasePart") then
	plate:Destroy()
end

-- Idempotent, for the same reason the client builder is: a Collision folder
-- left in the place by BuildNow would otherwise be doubled here.
for _, name in { "Collision", "Ground" } do
	local stale = workspace:FindFirstChild(name)
	if stale then
		stale:Destroy()
	end
end

local root = Instance.new("Folder")
root.Name = "Collision"
root.Parent = workspace

local started = os.clock()
local t0 = started
local built = 0
local i = 1
while i <= #Collision do
	local p = template:Clone()
	p.Size = Vector3.new(Collision[i + 3], Collision[i + 4], Collision[i + 5])
	p.Position = Vector3.new(Collision[i], Collision[i + 1], Collision[i + 2])
	p.Parent = root
	i += 6
	built += 1

	if built % 64 == 0 and os.clock() - t0 > MS_PER_FRAME then
		RunService.Heartbeat:Wait()
		t0 = os.clock()
	end
end

-- THE GROUND. The voxel ground layer is scenery like everything else in the
-- shell, so without this a car falls through the city on the first frame. One
-- part, sized from the baked district bounds.
local Meta = require(game:GetService("ReplicatedStorage"):WaitForChild("CityVisual"):WaitForChild("CityMeta"))
local ground = Instance.new("Part")
ground.Name = "Ground"
ground.Anchored = true
ground.CanCollide = true
ground.Transparency = 1
ground.CastShadow = false
ground.Size = Vector3.new(Meta.halfStuds * 2, 4, Meta.halfStuds * 2)
-- Top face at y = 0, which is where the voxel ground layer's top face is too.
ground.Position = Vector3.new(0, -2, 0)
ground.Parent = workspace

local spawnPad = Instance.new("SpawnLocation")
spawnPad.Name = "Start"
spawnPad.Anchored = true
spawnPad.CanCollide = true
spawnPad.Transparency = 1
spawnPad.CastShadow = false
spawnPad.Size = Vector3.new(12, 1, 12)
spawnPad.Position = Vector3.new(0, 40, 0)
spawnPad.Parent = workspace

print(("[collision] %d boxes in %.2fs"):format(built, os.clock() - started))
