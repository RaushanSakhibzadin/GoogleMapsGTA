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
local ReplicatedStorage = game:GetService("ReplicatedStorage")
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

-- Clearing, and the Baseplate with it: its top face is at y = 0, exactly
-- coplanar with the city's ground layer, and the two z-fight. Shared with the
-- client builder so the fix lives in one place.
local CityBuild = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityBuild"))
CityBuild.clearWorkspace({ "Collision", "Ground" })

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
local Meta = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityMeta"))
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

-- TOLD, RATHER THAN GUESSED AT. The loading screen in ReplicatedFirst has to
-- know when the ground and the collision are actually down -- a car handed to a
-- player before this finishes falls through the city. An attribute on Workspace
-- replicates to every client, including one that joins after this has already
-- run, which an event would not.
workspace:SetAttribute("CollisionReady", true)

print(("[collision] %d boxes in %.2fs"):format(built, os.clock() - started))
