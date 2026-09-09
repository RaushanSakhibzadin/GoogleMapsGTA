--!strict
-- The settings panel's other half: the profile is the only place a setting
-- lives once you have logged in twice, and this is the loop that gets it
-- there and back. Small on purpose -- ProfileService already owns the
-- document, the locking and the write cadence; this is just the wire.
--
-- SENT ON EVERY PROFILE CHANGE, not just on join. ProfileService.changed
-- fires once when the profile loads (which is when the panel actually needs
-- it) and again on anything else that touches the same document -- there is
-- nothing else that does today, but a settings snapshot that only arrived
-- once would be a second code path to keep in step with the first the moment
-- something else did.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Services = script.Parent:WaitForChild("Services")
local ProfileService = require(Services:WaitForChild("ProfileService"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Settings = Remotes:WaitForChild("Settings") :: RemoteEvent

ProfileService.changed.Event:Connect(function(player: Player, profile)
	Settings:FireClient(player, profile.settings)
end)

-- WHATEVER THE PANEL SENT, straight to ProfileService.setSettings -- it does
-- its own validation (a real volume group, a number, clamped 0..1) so a
-- stray or hostile FireServer cannot corrupt the document or grow it
-- unbounded. Nothing here needs to know the shape of a settings patch beyond
-- passing it through.
Settings.OnServerEvent:Connect(function(player: Player, patch)
	if typeof(patch) ~= "table" then
		return
	end
	ProfileService.setSettings(player, patch)
end)

-- BELT AND BRACES for whoever is already in the server the moment this
-- script starts running. In the normal boot order nobody is -- Players fills
-- up after every server script has already connected -- but this file does
-- not own join order (IncidentServer's onJoin is what actually calls
-- ProfileService.load) and should not have to assume it stays that way.
for _, player in Players:GetPlayers() do
	local profile = ProfileService.get(player.UserId)
	if profile then
		Settings:FireClient(player, profile.settings)
	end
end
