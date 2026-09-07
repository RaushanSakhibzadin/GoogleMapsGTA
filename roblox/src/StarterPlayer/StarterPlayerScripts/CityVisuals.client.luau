--!strict
-- Build the city on the client, from the baked chunk data.
--
-- ON THE CLIENT, AND ON PURPOSE. Every part this makes is decoration: the
-- collision the car actually hits is a separate, much smaller set built by the
-- server. So none of it replicates, none of it costs the server anything, and
-- none of it enters a physics broadphase -- which is what makes a hundred
-- thousand parts affordable at all.
--
-- The building itself lives in CityVisual/CityBuild, shared with the edit-mode
-- builder. This file is the part that is specific to being in a live game: the
-- frame budget, and clearing whatever was there before.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local CityVisual = ReplicatedStorage:WaitForChild("CityVisual")
local CityBuild = require(CityVisual:WaitForChild("CityBuild"))
local CityFlat = require(CityVisual:WaitForChild("CityFlat"))
local FlatMeta = require(CityVisual:WaitForChild("FlatMeta"))
local GroundTex = require(CityVisual:WaitForChild("GroundTex"))
local Base64 = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Base64"))

-- 'flat' draws each building from its own footprint, the way the browser does;
-- 'voxel' rasterises onto the lattice. Both are baked, so this is a one-word
-- change and a reconnect. See CONFIG.render in tools/roblox/config.mjs.
local RENDER = "flat"

local MS_PER_FRAME = 6 / 1000

-- WHETHER THE CITY CASTS SHADOWS AT ALL.
--
-- Off. Every shadow in the first Studio builds was thrown by the INVISIBLE
-- collision boxes -- transparency hides a part but does not stop it casting --
-- so they were fitted to the collision lattice rather than to the faces you can
-- see, lined up with nothing, and blinked as the camera moved. With those
-- silenced the honest options are no shadows, or shadows cast by the shell
-- itself, which is tens of thousands of casters and worth measuring before
-- assuming. The sun still shades faces by their normal either way.
local CAST_SHADOWS = false

-- ANYTHING ALREADY THERE GOES FIRST. BuildNow leaves its parts in Workspace
-- permanently -- it runs in the edit session, so its output is saved into the
-- place like any other instance -- and pressing Play then built a SECOND city
-- exactly on top of the first. Coincident surfaces fight over every pixel.
CityBuild.clearWorkspace({ "City" })

local started = os.clock()

if RENDER == "flat" then
	local root = Instance.new("Folder")
	root.Name = "City"
	root.Parent = workspace

	CityFlat.ground(GroundTex, Base64.decode, root)

	local made, buildings = 0, 0
	local t0 = os.clock()
	local FlatData = CityVisual:WaitForChild("FlatData")
	for _, entry in FlatMeta.chunks do
		local module = FlatData:FindFirstChild(("Flat_%d_%d"):format(entry[1], entry[2]))
		if not module then
			continue
		end
		local folder = Instance.new("Folder")
		folder.Name = module.Name
		for _, b in require(module) :: { any } do
			made += CityFlat.building(b, FlatMeta.palette, folder)
			buildings += 1
			-- CreateMeshPartAsync yields on its own, so the budget here is about
			-- not stacking a hundred of them into one frame's worth of work
			-- rather than about a loop that never lets go.
			if buildings % 24 == 0 and os.clock() - t0 > MS_PER_FRAME then
				RunService.Heartbeat:Wait()
				t0 = os.clock()
			end
		end
		folder.Parent = root
	end
	-- SAY WHAT FAILED, rather than quietly drawing fewer buildings. The first
	-- version of this reported only what it made, so 1,519 buildings coming out
	-- as one looked like a geometry bug rather than an exhausted resource.
	print(("[city] %d buildings, %d meshes in %.2fs (extruded footprints)")
		:format(buildings, made, os.clock() - started))
	if CityFlat.failed > 0 then
		warn(("[city] %d meshes FAILED -- first error: %s")
			:format(CityFlat.failed, tostring(CityFlat.firstError)))
	end
else
	local made, realHex = CityBuild.shell(CAST_SHADOWS, MS_PER_FRAME, function()
		RunService.Heartbeat:Wait()
	end)
	print(
		("[city] %d parts in %.2fs (%s)"):format(
			made,
			os.clock() - started,
			if CityBuild.isHex then (if realHex then "hex prisms" else "hex lattice, BLOCK fallback") else "boxes"
		)
	)
end
