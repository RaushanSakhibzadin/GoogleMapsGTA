--!strict
-- ONE CLIENT SCRIPT TELLING ANOTHER SOMETHING.
--
-- A ModuleScript is required once per client and its table is shared by every
-- script on that client, so a BindableEvent made in here is a signal any of
-- them can fire and any of them can listen to. Same mechanism as
-- Shared/PlayerCar, for the same reason: no copy, no round trip, no remote.
--
-- IT IS NOT A REMOTE AND MUST NOT BECOME ONE. Nothing here crosses the network
-- and nothing here is authoritative -- it is the minimap telling the big map
-- that somebody tapped it. Anything the server needs to believe goes through
-- ReplicatedStorage.Remotes and is validated there.

local ClientBus = {}

-- Tapping the minimap, or the map hotkey. Fired by Minimap, heard by BigMap.
-- They are separate scripts because they are separate screens: one runs every
-- frame at 20 Hz forever, the other is idle until it is opened.
ClientBus.toggleMap = Instance.new("BindableEvent")

return ClientBus
