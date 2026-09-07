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

local CityBuild = require(ReplicatedStorage:WaitForChild("CityVisual"):WaitForChild("CityBuild"))

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
